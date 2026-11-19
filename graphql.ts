// github-core-clone-01 — GraphQL v4 at POST /api/graphql.
//
// A small document matcher + field resolver for exactly the documents gh and
// github-mcp-server send (see sdk/conformance/checks-graphql.ts). No general
// GraphQL engine: a tiny tokenizer/parser for the documents' subset
// (operations, aliases, inline fragments, variables, inline enums/lists/input
// objects), then a typed selection-set executor over the shared Store.
//
// Auth: Bearer process.env.MAKEFUN_SHOP_TOKEN, else 401 {message}.
// Malformed JSON: 400 {message}. A JSON array body is a batch: one answer per
// operation, in order. An invalid field / unparseable document is HTTP 200
// with {data, errors} (GraphQL's convention), never a 4xx.
//
// Viewer login: the token names the seeded scenario viewer, `adaiversen`
// (wire.ts buildScenario() users[0], from the fixed SCENARIO_SEED
// 0x6a09e667f3bcc909 — the same seed every trial runs). The token itself is a
// `shpat_<hex>` string and carries no login, and the checks assert
// viewer.login === that scenario login, so a token-derived `user-<sha1>`
// login would fail viewer-login outright. repository() itself is
// owner-agnostic: it answers whatever store.getRepo(owner, name) holds, so a
// repo created under any owner reads back; only viewer.login is the fixed
// scenario login.
//
// Global ids are opaque and stable: base64("<Type>:<owner>/<repo>/<number>")
// (Repository / Issue / PullRequest / User / IssueComment), decoded back in
// node(id:) and in mutation inputs that take an id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, MalformedJsonError, parseJsonBody, sendJson } from './http.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

/** The login the bearer token names: the seeded scenario's viewer. */
export const VIEWER_LOGIN = 'adaiversen';

const GRAPHQL_PATH = '/api/graphql';

// -----------------------------------------------------------------------------------------------
// Global ids
// -----------------------------------------------------------------------------------------------

function encodeGlobalId(type: string, payload: string): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: unknown): { type: string; payload: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const type = text.slice(0, colon);
    const payload = text.slice(colon + 1);
    if (type === '' || payload === '') return null;
    // Re-encoding must round-trip, so a plain number / garbage string is rejected.
    if (encodeGlobalId(type, payload) !== id) return null;
    return { type, payload };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', `${repo.owner}/${repo.name}`);
}
function issueGlobalId(owner: string, repo: string, number: number): string {
  return encodeGlobalId('Issue', `${owner}/${repo}/${number}`);
}
function pullGlobalId(owner: string, repo: string, number: number): string {
  return encodeGlobalId('PullRequest', `${owner}/${repo}/${number}`);
}
function userGlobalId(login: string): string {
  return encodeGlobalId('User', login);
}
function commentGlobalId(owner: string, repo: string, number: number, commentId: number): string {
  return encodeGlobalId('IssueComment', `${owner}/${repo}/${number}/${commentId}`);
}

/** Split a decoded "owner/repo[/number[/commentId]]" payload. */
function splitPayload(payload: string): string[] {
  return payload.split('/');
}

// -----------------------------------------------------------------------------------------------
// Cursors (opaque; the offset in the filtered list, base64-encoded)
// -----------------------------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return -1;
    return Number.parseInt(match[1] ?? '0', 10);
  } catch {
    return -1;
  }
}

// -----------------------------------------------------------------------------------------------
// Tiny GraphQL document parser (the documents' subset)
// -----------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}
interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}
interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}
type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  kind: 'Operation';
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type Token =
  | { kind: 'Name'; value: string }
  | { kind: 'Int'; value: string }
  | { kind: 'Float'; value: string }
  | { kind: 'String'; value: string }
  | { kind: 'Punct'; value: string }
  | { kind: 'Spread' }
  | { kind: 'EOF' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'Spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'Punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'u' && j + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            j += 2;
          }
        } else {
          value += input[j] as string;
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'String', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(i));
      if (match === null) throw new Error(`Syntax Error: Unexpected character "${c}".`);
      const text = match[0];
      tokens.push(
        text.includes('.') || /[eE]/.test(text)
          ? { kind: 'Float', value: text }
          : { kind: 'Int', value: text },
      );
      i += text.length;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'Name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character "${c}".`);
  }
  tokens.push({ kind: 'EOF' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) {
      throw new Error(`Syntax Error: Expected "${value}".`);
    }
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'Name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Syntax Error: Expected ${value === undefined ? 'a name' : `"${value}"`}.`);
    }
    return token.value;
  }
  private skipDirectives(): void {
    // Directives (@foo, @foo(arg: 1)) appear in no check document, but skip them if present.
    while (true) {
      const token = this.peek();
      if (token.kind === 'Punct' && token.value === '@') {
        this.next();
        this.expectName();
        if (this.peek().kind === 'Punct' && (this.peek() as { value: string }).value === '(') {
          this.parseArguments();
        }
      } else {
        return;
      }
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'EOF') {
      const token = this.peek();
      if (token.kind === 'Punct' && token.value === '{') {
        operations.push({ kind: 'Operation', type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'Name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = this.next() as { value: string };
        let name: string | null = null;
        if (this.peek().kind === 'Name') name = this.expectName();
        // Variable definitions: ($x: Type = default, ...) — skipped; values come from `variables`.
        if (this.peek().kind === 'Punct' && (this.peek() as { value: string }).value === '(') {
          this.skipBalancedParens();
        }
        this.skipDirectives();
        operations.push({
          kind: 'Operation',
          type: type.value as 'query' | 'mutation' | 'subscription',
          name,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (token.kind === 'Name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { kind: 'Fragment', name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error('Syntax Error: Unexpected token in document.');
      }
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    while (true) {
      const token = this.next();
      if (token.kind === 'EOF') throw new Error('Syntax Error: Unterminated parentheses.');
      if (token.kind === 'Punct' && token.value === '(') depth += 1;
      if (token.kind === 'Punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (token.kind === 'Punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'EOF') throw new Error('Syntax Error: Unterminated selection set.');
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'Spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'Name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'Name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'FragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind !== 'Name') throw new Error('Syntax Error: Expected a field name.');
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'Punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'Punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!(this.peek().kind === 'Punct' && (this.peek() as { value: string }).value === '(')) return args;
    this.next();
    while (true) {
      const token = this.peek();
      if (token.kind === 'Punct' && token.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'Punct':
        if (token.value === '$') return { kind: 'Variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek().kind === 'Punct' && (this.peek() as { value: string }).value === ']')) {
            if (this.peek().kind === 'EOF') throw new Error('Syntax Error: Unterminated list.');
            values.push(this.parseValue());
          }
          this.next();
          return { kind: 'List', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!(this.peek().kind === 'Punct' && (this.peek() as { value: string }).value === '}')) {
            if (this.peek().kind === 'EOF') throw new Error('Syntax Error: Unterminated input object.');
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.next();
          return { kind: 'Object', fields };
        }
        throw new Error(`Syntax Error: Unexpected "${token.value}".`);
      case 'String':
        return { kind: 'String', value: token.value };
      case 'Int':
        return { kind: 'Int', value: Number.parseInt(token.value, 10) };
      case 'Float':
        return { kind: 'Float', value: Number.parseFloat(token.value) };
      case 'Name':
        if (token.value === 'true') return { kind: 'Boolean', value: true };
        if (token.value === 'false') return { kind: 'Boolean', value: false };
        if (token.value === 'null') return { kind: 'Null' };
        return { kind: 'Enum', value: token.value };
      default:
        throw new Error('Syntax Error: Unexpected value.');
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Schema: the fields each type holds (drives validation + introspection)
// -----------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'private', 'url', 'createdAt', 'updatedAt', 'forkCount', 'stargazerCount', 'visibility',
    'defaultBranch', 'homepageUrl', 'licenseInfo', 'languages', 'topics', 'watchers', 'labels',
    'milestones', 'diskUsage', 'isFork', 'isArchived', 'hasWikiEnabled', 'hasProjectsEnabled',
    'hasDownloadsEnabled', 'parent', 'source', 'openGraphImageUrl',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'user', 'createdAt', 'updatedAt', 'url',
    'comments', 'labels', 'assignees', 'repository', 'closed', 'locked', 'viewerCanUpdate',
    'timelineItems', 'participants', 'reactions', 'milestone', 'closedAt',
  ],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'user', 'createdAt', 'updatedAt', 'url', 'issue', 'repository'],
  IssueCommentConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'files', 'author', 'user', 'createdAt', 'updatedAt', 'url', 'headRef', 'baseRef', 'mergeCommit',
    'mergedAt', 'isDraft', 'additions', 'deletions', 'changedFiles', 'repository', 'labels',
    'comments', 'viewerCanUpdate', 'baseRefOid', 'headRefOid', 'commits', 'reviews',
  ],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status', 'filename'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  LabelConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  LabelEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const QUERY_FIELDS = ['viewer', 'repository', 'node', '__type', '__schema'];
const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'];

function typeField(name: string): Record<string, unknown> {
  return {
    __typename: '__Field',
    name,
    description: null,
    type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
    args: [],
    isDeprecated: false,
    deprecationReason: null,
  };
}

function typeInfo(name: string): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: SEARCH_TYPE_VALUES.map((value) => ({
        __typename: '__EnumValue',
        name: value,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
      })),
      inputFields: null,
      interfaces: [],
      possibleTypes: [],
      ofType: null,
      specifiedByURL: null,
    };
  }
  const fields = TYPE_FIELDS[name];
  if (fields === undefined) return null;
  const kind = name.endsWith('Connection') || name.endsWith('Edge') ? 'OBJECT' : 'OBJECT';
  return {
    __typename: '__Type',
    name,
    kind,
    description: null,
    fields: fields.map((field) => typeField(field)),
    enumValues: null,
    inputFields: [],
    interfaces: [],
    possibleTypes: [],
    ofType: null,
    specifiedByURL: null,
  };
}

// -----------------------------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;
type ResolverFn = (args: AnyRecord, ctx: ExecContext) => unknown;

interface ExecContext {
  store: Store;
  variables: AnyRecord;
  errors: { message: string; path?: (string | number)[] }[];
  fragments: Map<string, FragmentNode>;
}

function resolveValue(node: ValueNode, variables: AnyRecord): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name] ?? null;
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((value) => resolveValue(value, variables));
    case 'Object': {
      const out: AnyRecord = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ExecContext): AnyRecord {
  const args: AnyRecord = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  return args;
}

function allowedFields(typeName: string): string[] | null {
  if (typeName === 'Query') return QUERY_FIELDS;
  if (typeName === 'Mutation') return MUTATION_FIELDS;
  return TYPE_FIELDS[typeName] ?? null;
}

/** Execute a selection set against a plain object carrying __typename (or a null). */
function select(
  value: unknown,
  selectionSet: SelectionNode[] | null,
  ctx: ExecContext,
  typeName: string,
  path: (string | number)[],
): unknown {
  if (selectionSet === null) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      select(entry, selectionSet, ctx, (entry as AnyRecord)?.__typename as string, path),
    );
  }
  const obj = value as AnyRecord;
  const out: AnyRecord = {};
  const allowed = allowedFields(typeName);
  for (const selection of selectionSet) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== typeName && fragment.typeCondition !== 'Node') continue;
      const sub = select(obj, fragment.selectionSet, ctx, typeName, path) as AnyRecord;
      Object.assign(out, sub);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const sub = select(obj, selection.selectionSet, ctx, typeName, path) as AnyRecord;
      Object.assign(out, sub);
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (allowed !== null && !allowed.includes(field.name)) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${typeName}".`,
        path: [...path, key],
      });
      continue;
    }
    let fieldValue: unknown = obj[field.name];
    if (typeof fieldValue === 'function') {
      fieldValue = (fieldValue as ResolverFn)(resolveArgs(field, ctx), ctx);
    }
    if (field.selectionSet !== null && field.selectionSet !== undefined) {
      if (fieldValue === null || fieldValue === undefined) {
        out[key] = null;
      } else if (Array.isArray(fieldValue)) {
        out[key] = fieldValue.map((entry) =>
          select(entry, field.selectionSet, ctx, (entry as AnyRecord)?.__typename as string, [...path, key]),
        );
      } else {
        const childType = ((fieldValue as AnyRecord).__typename as string | undefined) ?? field.name;
        out[key] = select(fieldValue, field.selectionSet, ctx, childType, [...path, key]);
      }
    } else {
      out[key] = fieldValue === undefined ? null : fieldValue;
    }
  }
  return out;
}

// -- value builders -----------------------------------------------------------

function userObject(login: string): AnyRecord {
  return {
    __typename: 'User',
    id: userGlobalId(login),
    login,
    name: login,
    email: `${login}@example.invalid`,
    avatarUrl: null,
    url: `https://github.com/${login}`,
  };
}

function issueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(owner: string, repoName: string, issue: Issue): AnyRecord {
  return {
    __typename: 'Issue',
    id: issueGlobalId(owner, repoName, issue.number),
    number: issue.number,
    title: issue.title,
    state: issueState(issue.state),
    body: issue.body ?? '',
    author: userObject(issue.user.login),
    user: userObject(issue.user.login),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://github.com/${owner}/${repoName}/issues/${issue.number}`,
    closed: issue.state === 'closed',
    locked: false,
    viewerCanUpdate: true,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    repository: (args: AnyRecord, ctx: ExecContext) => repoObject(ctx.store.getRepo(owner, repoName)),
    labels: () => labelConnection(issue.labels.map((name) => ({ name, color: '000000', description: '' }))),
    comments: (_args: AnyRecord, ctx: ExecContext) =>
      commentConnection(ctx.store.listComments(owner, repoName, issue.number), owner, repoName, issue.number),
    assignees: () => ({ __typename: 'UserConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    milestone: null,
    timelineItems: () => ({ __typename: 'IssueTimelineItemsConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    participants: () => ({ __typename: 'UserConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    reactions: () => ({ __typename: 'ReactionConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
  };
}

function emptyPageInfo(): AnyRecord {
  return { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
}

function connection<T>(
  typeName: string,
  edgeType: string,
  items: T[],
  first: number | undefined,
  after: unknown,
  toNode: (item: T) => AnyRecord,
): AnyRecord {
  const start = decodeCursor(after) + 1;
  const from = Math.max(0, start);
  const limit = first === undefined || first === null ? items.length : Math.max(0, Math.trunc(first as number));
  const page = items.slice(from, from + limit);
  const nodes = page.map((item) => toNode(item));
  const edges = page.map((item, i) => ({
    __typename: edgeType,
    node: toNode(item),
    cursor: encodeCursor(from + i),
  }));
  const hasNextPage = from + page.length < items.length;
  return {
    __typename: typeName,
    nodes,
    edges,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: from > 0,
      startCursor: page.length > 0 ? encodeCursor(from) : null,
      endCursor: page.length > 0 ? encodeCursor(from + page.length - 1) : null,
    },
  };
}

function labelConnection(labels: { name: string; color: string; description: string }[]): AnyRecord {
  return {
    __typename: 'LabelConnection',
    nodes: labels.map((label) => ({ __typename: 'Label', id: encodeGlobalId('Label', label.name), ...label, url: null })),
    edges: labels.map((label, i) => ({
      __typename: 'LabelEdge',
      node: { __typename: 'Label', id: encodeGlobalId('Label', label.name), ...label, url: null },
      cursor: encodeCursor(i),
    })),
    totalCount: labels.length,
    pageInfo: emptyPageInfo(),
  };
}

function commentObject(
  owner: string,
  repoName: string,
  issueNumber: number,
  comment: { id: number; body: string; user: { login: string }; createdAt: string; updatedAt: string },
): AnyRecord {
  return {
    __typename: 'IssueComment',
    id: commentGlobalId(owner, repoName, issueNumber, comment.id),
    body: comment.body,
    author: userObject(comment.user.login),
    user: userObject(comment.user.login),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: `https://github.com/${owner}/${repoName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue: null,
    repository: null,
  };
}

function commentConnection(
  comments: { id: number; body: string; user: { login: string }; createdAt: string; updatedAt: string }[],
  owner: string,
  repoName: string,
  issueNumber: number,
): AnyRecord {
  return connection(
    'IssueCommentConnection',
    'IssueCommentEdge',
    comments,
    undefined,
    null,
    (comment) => commentObject(owner, repoName, issueNumber, comment),
  );
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullObject(owner: string, repoName: string, pull: PullRequest): AnyRecord {
  return {
    __typename: 'PullRequest',
    id: pullGlobalId(owner, repoName, pull.number),
    number: pull.number,
    title: pull.title,
    state: pullState(pull),
    body: pull.body ?? '',
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN',
    merged: pull.merged,
    author: userObject(pull.user.login),
    user: userObject(pull.user.login),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: `https://github.com/${owner}/${repoName}/pull/${pull.number}`,
    headRef: { __typename: 'Ref', id: encodeGlobalId('Ref', `${owner}/${repoName}/${pull.head.ref}`), name: pull.head.ref, prefix: 'refs/heads/', target: null },
    baseRef: { __typename: 'Ref', id: encodeGlobalId('Ref', `${owner}/${repoName}/${pull.base.ref}`), name: pull.base.ref, prefix: 'refs/heads/', target: null },
    mergeCommit: null,
    mergedAt: pull.mergedAt,
    isDraft: false,
    additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: pull.files.length,
    baseRefOid: pull.base.sha,
    headRefOid: pull.head.sha,
    repository: (args: AnyRecord, ctx: ExecContext) => repoObject(ctx.store.getRepo(owner, repoName)),
    labels: () => labelConnection([]),
    comments: () => commentConnection([], owner, repoName, pull.number),
    commits: () => ({ __typename: 'PullRequestCommitConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    reviews: () => ({ __typename: 'PullRequestReviewConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    files: (args: AnyRecord, ctx: ExecContext) => {
      let files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
      try {
        files = ctx.store.getPullFiles(owner, repoName, pull.number);
      } catch {
        files = pull.files;
      }
      return connection(
        'PullRequestChangedFileConnection',
        'PullRequestChangedFileEdge',
        files,
        typeof args.first === 'number' ? args.first : undefined,
        args.after ?? null,
        (file) => ({
          __typename: 'PullRequestChangedFile',
          path: file.filename,
          filename: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          status: file.status,
        }),
      );
    },
  };
}

function repoObject(repo: Repo | null): AnyRecord | null {
  if (repo === null) return null;
  const { owner, name } = repo;
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name,
    nameWithOwner: repo.fullName,
    owner: userObject(owner),
    defaultBranchRef: {
      __typename: 'Ref',
      id: encodeGlobalId('Ref', `${owner}/${name}/${repo.defaultBranch}`),
      name: repo.defaultBranch,
      prefix: 'refs/heads/',
      target: null,
    },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    private: repo.private,
    url: `https://github.com/${repo.fullName}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    forkCount: 0,
    stargazerCount: 0,
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
    defaultBranch: repo.defaultBranch,
    homepageUrl: null,
    licenseInfo: null,
    languages: null,
    topics: () => ({ __typename: 'TopicConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    watchers: () => ({ __typename: 'UserConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    labels: (_args: AnyRecord, ctx: ExecContext) =>
      labelConnection(ctx.store.listLabels(owner, name).map((label) => ({ name: label.name, color: label.color, description: label.description }))),
    milestones: () => ({ __typename: 'MilestoneConnection', nodes: [], edges: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    diskUsage: 0,
    isFork: false,
    isArchived: false,
    hasWikiEnabled: false,
    hasProjectsEnabled: true,
    hasDownloadsEnabled: true,
    parent: null,
    source: null,
    openGraphImageUrl: null,
    issue: (args: AnyRecord, ctx: ExecContext) => {
      if (typeof args.number !== 'number') return null;
      const issue = ctx.store.getIssue(owner, name, args.number);
      return issue === null ? null : issueObject(owner, name, issue);
    },
    issues: (args: AnyRecord, ctx: ExecContext) => {
      const states = Array.isArray(args.states) ? (args.states as string[]) : [];
      const state = states.includes('OPEN') && !states.includes('CLOSED')
        ? 'open'
        : states.includes('CLOSED') && !states.includes('OPEN')
          ? 'closed'
          : 'all';
      const orderBy = (args.orderBy ?? {}) as AnyRecord;
      const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
      const issues = ctx.store.listIssues(owner, name, { state, sort: 'created', direction });
      return connection(
        'IssueConnection',
        'IssueEdge',
        issues,
        typeof args.first === 'number' ? args.first : undefined,
        args.after ?? null,
        (issue) => issueObject(owner, name, issue),
      );
    },
    pullRequests: (args: AnyRecord, ctx: ExecContext) => {
      const pulls = ctx.store.listPulls(owner, name, 'all');
      return connection(
        'PullRequestConnection',
        'PullRequestEdge',
        pulls,
        typeof args.first === 'number' ? args.first : undefined,
        args.after ?? null,
        (pull) => pullObject(owner, name, pull),
      );
    },
    pullRequest: (args: AnyRecord, ctx: ExecContext) => {
      if (typeof args.number !== 'number') return null;
      const pull = ctx.store.getPull(owner, name, args.number);
      return pull === null ? null : pullObject(owner, name, pull);
    },
  };
}

// -- mutations -----------------------------------------------------------------

function decodeRepoId(input: AnyRecord): { owner: string; name: string } | null {
  const decoded = decodeGlobalId(input.repositoryId);
  if (decoded === null || decoded.type !== 'Repository') return null;
  const parts = splitPayload(decoded.payload);
  if (parts.length !== 2) return null;
  return { owner: parts[0] as string, name: parts[1] as string };
}

function decodeIssueId(input: AnyRecord, key: string): { owner: string; repo: string; number: number } | null {
  const decoded = decodeGlobalId(input[key]);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const parts = splitPayload(decoded.payload);
  if (parts.length !== 3) return null;
  const number = Number.parseInt(parts[2] as string, 10);
  if (!Number.isInteger(number)) return null;
  return { owner: parts[0] as string, repo: parts[1] as string, number };
}

function decodePullId(input: AnyRecord, key: string): { owner: string; repo: string; number: number } | null {
  const decoded = decodeGlobalId(input[key]);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const parts = splitPayload(decoded.payload);
  if (parts.length !== 3) return null;
  const number = Number.parseInt(parts[2] as string, 10);
  if (!Number.isInteger(number)) return null;
  return { owner: parts[0] as string, repo: parts[1] as string, number };
}

function executeMutation(field: FieldNode, ctx: ExecContext): AnyRecord | null {
  const args = resolveArgs(field, ctx);
  const input = (args.input ?? {}) as AnyRecord;
  switch (field.name) {
    case 'createIssue': {
      const repo = decodeRepoId(input);
      if (repo === null) throw new Error('createIssue: repositoryId is not a Repository global id.');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createIssue: title is required.');
      const issue = ctx.store.createIssue(repo.owner, repo.name, {
        title: input.title,
        body: typeof input.body === 'string' ? input.body : '',
        labels: Array.isArray(input.labelIds) ? [] : undefined,
      });
      return {
        __typename: 'CreateIssuePayload',
        issue: issueObject(repo.owner, repo.name, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    }
    case 'closeIssue': {
      const target = decodeIssueId(input, 'issueId');
      if (target === null) throw new Error('closeIssue: issueId is not an Issue global id.');
      const issue = ctx.store.patchIssue(target.owner, target.repo, target.number, { state: 'closed' });
      if (issue === null) throw new Error(`closeIssue: issue #${target.number} was not found.`);
      return {
        __typename: 'CloseIssuePayload',
        issue: issueObject(target.owner, target.repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    }
    case 'createPullRequest': {
      const repo = decodeRepoId(input);
      if (repo === null) throw new Error('createPullRequest: repositoryId is not a Repository global id.');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (head === '' || base === '') throw new Error('createPullRequest: headRefName and baseRefName are required.');
      const pull = ctx.store.createPull(repo.owner, repo.name, {
        head,
        base,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullObject(repo.owner, repo.name, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    }
    case 'mergePullRequest': {
      const target = decodePullId(input, 'pullRequestId');
      if (target === null) throw new Error('mergePullRequest: pullRequestId is not a PullRequest global id.');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const method = methodRaw === 'MERGE' ? 'merge' : methodRaw === 'REBASE' ? 'rebase' : 'squash';
      ctx.store.mergePull(target.owner, target.repo, target.number, method);
      const pull = ctx.store.getPull(target.owner, target.repo, target.number);
      if (pull === null) throw new Error(`mergePullRequest: pull request #${target.number} was not found.`);
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullObject(target.owner, target.repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    }
    case 'addComment': {
      const target = decodeIssueId(input, 'subjectId');
      if (target === null) throw new Error('addComment: subjectId is not an Issue global id.');
      if (typeof input.body !== 'string' || input.body === '') throw new Error('addComment: body is required.');
      const comment = ctx.store.addComment(target.owner, target.repo, target.number, input.body);
      if (comment === null) throw new Error(`addComment: issue #${target.number} was not found.`);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: commentObject(target.owner, target.repo, target.number, comment),
          cursor: encodeCursor(0),
        },
        subject: issueObject(target.owner, target.repo, ctx.store.getIssue(target.owner, target.repo, target.number) as Issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    }
    default:
      throw new Error(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

function executeQuery(field: FieldNode, ctx: ExecContext): unknown {
  const args = resolveArgs(field, ctx);
  switch (field.name) {
    case 'viewer':
      return userObject(VIEWER_LOGIN);
    case 'repository': {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      return repoObject(ctx.store.getRepo(args.owner, args.name));
    }
    case 'node': {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      const parts = splitPayload(decoded.payload);
      if (decoded.type === 'Repository' && parts.length === 2) {
        return repoObject(ctx.store.getRepo(parts[0] as string, parts[1] as string));
      }
      if (decoded.type === 'Issue' && parts.length === 3) {
        const issue = ctx.store.getIssue(parts[0] as string, parts[1] as string, Number.parseInt(parts[2] as string, 10));
        return issue === null ? null : issueObject(parts[0] as string, parts[1] as string, issue);
      }
      if (decoded.type === 'PullRequest' && parts.length === 3) {
        const pull = ctx.store.getPull(parts[0] as string, parts[1] as string, Number.parseInt(parts[2] as string, 10));
        return pull === null ? null : pullObject(parts[0] as string, parts[1] as string, pull);
      }
      if (decoded.type === 'User' && parts.length === 1) return userObject(parts[0] as string);
      if (decoded.type === 'IssueComment' && parts.length === 4) {
        const comments = ctx.store.listComments(parts[0] as string, parts[1] as string, Number.parseInt(parts[2] as string, 10));
        const comment = comments.find((entry) => entry.id === Number.parseInt(parts[3] as string, 10));
        return comment === undefined
          ? null
          : commentObject(parts[0] as string, parts[1] as string, Number.parseInt(parts[2] as string, 10), comment);
      }
      return null;
    }
    case '__type': {
      if (typeof args.name !== 'string') return null;
      return typeInfo(args.name);
    }
    case '__schema':
      return {
        __typename: '__Schema',
        queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
        mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
        subscriptionType: null,
        types: [],
        directives: [],
      };
    default:
      throw new Error(`Cannot query field "${field.name}" on type "Query".`);
  }
}

/** Run one operation document; never throws for a GraphQL-level problem. */
function executeOperation(
  query: string,
  variables: AnyRecord,
  operationName: string | undefined,
  store: Store,
): { data: unknown; errors?: { message: string; path?: (string | number)[] }[] } {
  const ctx: ExecContext = { store, variables, errors: [], fragments: new Map() };
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  ctx.fragments = parsed.fragments;
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = parsed.operations.find((entry) => entry.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (parsed.operations.length === 1) {
    operation = parsed.operations[0];
  } else if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const data: AnyRecord = {};
  const allowed = operation.type === 'mutation' ? MUTATION_FIELDS : operation.type === 'subscription' ? [] : QUERY_FIELDS;
  const typeName = operation.type === 'mutation' ? 'Mutation' : operation.type === 'subscription' ? 'Subscription' : 'Query';
  for (const selection of operation.selectionSet) {
    if (selection.kind !== 'Field') {
      // A fragment at the top level: apply it against the root type.
      const sub = select(
        typeName === 'Query' ? { __typename: 'Query' } : { __typename: 'Mutation' },
        [selection],
        ctx,
        typeName,
        [],
      ) as AnyRecord;
      Object.assign(data, sub);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (!allowed.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: [key] });
      data[key] = null;
      continue;
    }
    try {
      const value = operation.type === 'mutation' ? executeMutation(selection, ctx) : executeQuery(selection, ctx);
      if (selection.selectionSet === null) {
        data[key] = value;
      } else if (value === null || value === undefined) {
        data[key] = null;
      } else {
        const childType = ((value as AnyRecord).__typename as string | undefined) ?? selection.name;
        data[key] = select(value, selection.selectionSet, ctx, childType, [key]);
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
      data[key] = null;
    }
  }
  // A top-level field error leaves the other fields in `data`; when every field
  // failed and the document named no valid field at all, GraphQL answers data null
  // only for a wholly unknown operation — here partial data is the correct shape.
  const result: { data: unknown; errors?: { message: string; path?: (string | number)[] }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// -----------------------------------------------------------------------------------------------
// HTTP handler
// -----------------------------------------------------------------------------------------------

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  if (pathOf(req) !== GRAPHQL_PATH) return false;

  // Only POST is supported.
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // Auth: the token in process.env.MAKEFUN_SHOP_TOKEN.
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const token = bearerToken(req);
  if (expected === '' || token === null || token !== expected) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    if (err instanceof MalformedJsonError) {
      sendJson(res, 400, { message: err.message });
      return true;
    }
    throw err;
  }

  // Batched operations: a JSON array of {query, variables, operationName}.
  if (Array.isArray(body)) {
    const answers = body.map((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof (entry as AnyRecord).query !== 'string') {
        return { data: null, errors: [{ message: 'Must provide query string.' }] };
      }
      const op = entry as AnyRecord;
      return executeOperation(
        op.query as string,
        (op.variables ?? {}) as AnyRecord,
        typeof op.operationName === 'string' ? op.operationName : undefined,
        store,
      );
    });
    sendJson(res, 200, answers);
    return true;
  }

  if (body === null || typeof body !== 'object' || typeof (body as AnyRecord).query !== 'string') {
    sendJson(res, 200, { data: null, errors: [{ message: 'Must provide query string.' }] });
    return true;
  }
  const op = body as AnyRecord;
  const answer = executeOperation(
    op.query as string,
    (op.variables ?? {}) as AnyRecord,
    typeof op.operationName === 'string' ? op.operationName : undefined,
    store,
  );
  sendJson(res, 200, answer);
  return true;
}
