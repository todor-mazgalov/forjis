/**
 * Recursive-descent parser and evaluator for outcome rule expressions.
 *
 * Supports comparison operators (<, >, <=, >=, ==, !=), logical operators
 * (&&, ||, !), and parenthesized grouping. Identifiers are metric names
 * resolved against a scores map. No use of eval().
 *
 * Grammar:
 *   expression -> or_expr
 *   or_expr    -> and_expr ( '||' and_expr )*
 *   and_expr   -> not_expr ( '&&' not_expr )*
 *   not_expr   -> '!' not_expr | primary
 *   primary    -> '(' expression ')' | comparison
 *   comparison -> IDENTIFIER OPERATOR NUMBER
 */

import { ExpressionError } from './errors.js';

/** Token types produced by the lexer. */
export type TokenType =
  | 'NUMBER'
  | 'IDENTIFIER'
  | 'OPERATOR'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'LPAREN'
  | 'RPAREN'
  | 'EOF';

/** A single lexer token with type, value, and source position. */
export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

/**
 * Tokenizes an expression string into an array of tokens.
 *
 * Recognizes numbers, identifiers (metric names), comparison operators,
 * logical operators, and parentheses. Whitespace is skipped.
 *
 * @param expression - The expression string to tokenize.
 * @returns An array of tokens terminated by an EOF token.
 * @throws {ExpressionError} If an unrecognized character is encountered.
 */
export function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < expression.length) {
    const ch = expression[pos];

    if (/\s/.test(ch)) {
      pos++;
      continue;
    }

    if (/\d/.test(ch)) {
      const start = pos;
      while (pos < expression.length && /\d/.test(expression[pos])) {
        pos++;
      }
      tokens.push({ type: 'NUMBER', value: expression.slice(start, pos), position: start });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = pos;
      while (pos < expression.length && /\w/.test(expression[pos])) {
        pos++;
      }
      tokens.push({ type: 'IDENTIFIER', value: expression.slice(start, pos), position: start });
      continue;
    }

    if (ch === '&' && expression[pos + 1] === '&') {
      tokens.push({ type: 'AND', value: '&&', position: pos });
      pos += 2;
      continue;
    }

    if (ch === '|' && expression[pos + 1] === '|') {
      tokens.push({ type: 'OR', value: '||', position: pos });
      pos += 2;
      continue;
    }

    if (ch === '!') {
      if (expression[pos + 1] === '=') {
        tokens.push({ type: 'OPERATOR', value: '!=', position: pos });
        pos += 2;
      } else {
        tokens.push({ type: 'NOT', value: '!', position: pos });
        pos++;
      }
      continue;
    }

    if (ch === '<' || ch === '>') {
      if (expression[pos + 1] === '=') {
        tokens.push({ type: 'OPERATOR', value: ch + '=', position: pos });
        pos += 2;
      } else {
        tokens.push({ type: 'OPERATOR', value: ch, position: pos });
        pos++;
      }
      continue;
    }

    if (ch === '=' && expression[pos + 1] === '=') {
      tokens.push({ type: 'OPERATOR', value: '==', position: pos });
      pos += 2;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(', position: pos });
      pos++;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')', position: pos });
      pos++;
      continue;
    }

    throw new ExpressionError(expression, `Unexpected character "${ch}" at position ${pos}`);
  }

  tokens.push({ type: 'EOF', value: '', position: pos });
  return tokens;
}

/**
 * Evaluates an expression against a scores map, returning a boolean.
 *
 * Parses the expression using recursive descent and evaluates each
 * comparison by looking up identifiers in the scores map.
 *
 * @param expression - The expression string to evaluate.
 * @param scores - Map of metric names to their numeric scores.
 * @param knownMetrics - Set of valid metric names for validation.
 * @returns True if the expression evaluates to true.
 * @throws {ExpressionError} If the expression is invalid or references unknown metrics.
 */
export function evaluateExpression(
  expression: string,
  scores: Record<string, number>,
  knownMetrics: Set<string>
): boolean {
  const tokens = tokenize(expression);
  const parser = new Parser(expression, tokens, scores, knownMetrics);
  return parser.parse();
}

/**
 * Validates that all identifiers in the expression are known metrics.
 *
 * Does not evaluate the expression; only checks that metric references
 * are valid.
 *
 * @param expression - The expression string to validate.
 * @param knownMetrics - Set of valid metric names.
 * @throws {ExpressionError} If an unknown metric is found.
 */
export function validateExpression(
  expression: string,
  knownMetrics: Set<string>
): void {
  const tokens = tokenize(expression);

  for (const token of tokens) {
    if (token.type === 'IDENTIFIER' && !knownMetrics.has(token.value)) {
      throw new ExpressionError(expression, `Unknown metric "${token.value}"`);
    }
  }
}

/**
 * Recursive-descent parser for rule expressions.
 *
 * Implements the grammar defined in the module doc comment. Evaluates
 * expressions as it parses, returning boolean results.
 */
class Parser {
  private pos = 0;

  constructor(
    private readonly expression: string,
    private readonly tokens: Token[],
    private readonly scores: Record<string, number>,
    private readonly knownMetrics: Set<string>
  ) {}

  /** Parses the full expression and ensures all tokens are consumed. */
  parse(): boolean {
    const result = this.parseOrExpr();
    if (this.current().type !== 'EOF') {
      throw new ExpressionError(
        this.expression,
        `Unexpected token "${this.current().value}" at position ${this.current().position}`
      );
    }
    return result;
  }

  /** Parses: or_expr -> and_expr ( '||' and_expr )* */
  private parseOrExpr(): boolean {
    let left = this.parseAndExpr();
    while (this.current().type === 'OR') {
      this.advance();
      const right = this.parseAndExpr();
      left = left || right;
    }
    return left;
  }

  /** Parses: and_expr -> not_expr ( '&&' not_expr )* */
  private parseAndExpr(): boolean {
    let left = this.parseNotExpr();
    while (this.current().type === 'AND') {
      this.advance();
      const right = this.parseNotExpr();
      left = left && right;
    }
    return left;
  }

  /** Parses: not_expr -> '!' not_expr | primary */
  private parseNotExpr(): boolean {
    if (this.current().type === 'NOT') {
      this.advance();
      return !this.parseNotExpr();
    }
    return this.parsePrimary();
  }

  /** Parses: primary -> '(' expression ')' | comparison */
  private parsePrimary(): boolean {
    if (this.current().type === 'LPAREN') {
      this.advance();
      const result = this.parseOrExpr();
      if (this.current().type !== 'RPAREN') {
        throw new ExpressionError(
          this.expression,
          `Expected ")" at position ${this.current().position}`
        );
      }
      this.advance();
      return result;
    }
    return this.parseComparison();
  }

  /**
   * Parses: comparison -> IDENTIFIER OPERATOR NUMBER
   *
   * Looks up the identifier in the scores map and applies the comparison.
   */
  private parseComparison(): boolean {
    const identToken = this.current();
    if (identToken.type !== 'IDENTIFIER') {
      throw new ExpressionError(
        this.expression,
        `Expected metric name at position ${identToken.position}, got "${identToken.value}"`
      );
    }

    if (!this.knownMetrics.has(identToken.value)) {
      throw new ExpressionError(this.expression, `Unknown metric "${identToken.value}"`);
    }

    const metricValue = this.scores[identToken.value];
    if (metricValue === undefined) {
      throw new ExpressionError(this.expression, `No score for metric "${identToken.value}"`);
    }

    this.advance();

    const opToken = this.current();
    if (opToken.type !== 'OPERATOR') {
      throw new ExpressionError(
        this.expression,
        `Expected comparison operator at position ${opToken.position}, got "${opToken.value}"`
      );
    }
    this.advance();

    const numToken = this.current();
    if (numToken.type !== 'NUMBER') {
      throw new ExpressionError(
        this.expression,
        `Expected number at position ${numToken.position}, got "${numToken.value}"`
      );
    }
    this.advance();

    const numValue = parseInt(numToken.value, 10);
    return applyOperator(metricValue, opToken.value, numValue);
  }

  /** Returns the current token without advancing. */
  private current(): Token {
    return this.tokens[this.pos];
  }

  /** Advances to the next token. */
  private advance(): void {
    this.pos++;
  }
}

/**
 * Applies a comparison operator to two numeric values.
 *
 * @param left - The left operand (metric score).
 * @param op - The comparison operator string.
 * @param right - The right operand (threshold number).
 * @returns The boolean result of the comparison.
 */
function applyOperator(left: number, op: string, right: number): boolean {
  switch (op) {
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    default:
      return false;
  }
}
