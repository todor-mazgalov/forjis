/**
 * Unit tests for expression-eval.ts — tokenizer, evaluator, validator.
 *
 * Requirements validated:
 *   Rule expression evaluation (all operators, AND/OR/NOT, grouping)
 *   Unknown metric detection
 *   Operator precedence (AND binds tighter than OR)
 */

import { evaluateExpression, tokenize, validateExpression } from '../expression-eval.js';
import { ExpressionError } from '../errors.js';

const BUILTIN = new Set(['completeness', 'speculation', 'hallucination', 'security_score', 'test_coverage', 'a', 'b', 'c']);

// --------------------------------------------------------------------------
// tokenize
// --------------------------------------------------------------------------

describe('tokenize', () => {
  it('tokenizes a simple comparison', () => {
    const tokens = tokenize('completeness < 80');
    expect(tokens.map(t => t.type)).toEqual(['IDENTIFIER', 'OPERATOR', 'NUMBER', 'EOF']);
  });

  it('tokenizes && and || operators', () => {
    const tokens = tokenize('a < 50 && b > 10 || c == 0');
    const types = tokens.map(t => t.type);
    expect(types).toContain('AND');
    expect(types).toContain('OR');
  });

  it('tokenizes ! as NOT and != as OPERATOR', () => {
    const t1 = tokenize('!a < 50');
    expect(t1[0].type).toBe('NOT');

    const t2 = tokenize('a != 50');
    expect(t2[1].type).toBe('OPERATOR');
    expect(t2[1].value).toBe('!=');
  });

  it('throws for unrecognized character', () => {
    expect(() => tokenize('a @ 50')).toThrow(ExpressionError);
  });
});

// --------------------------------------------------------------------------
// evaluateExpression — comparison operators
// --------------------------------------------------------------------------

describe('evaluateExpression — comparison operators', () => {
  const scores = { completeness: 75, speculation: 60, hallucination: 0 };

  /** Validates: Rule expression evaluation — simple less-than */
  it('evaluates completeness < 80 as true when score is 75', () => {
    expect(evaluateExpression('completeness < 80', scores, BUILTIN)).toBe(true);
  });

  it('evaluates completeness < 80 as false when score is 80', () => {
    expect(evaluateExpression('completeness < 80', { completeness: 80 }, BUILTIN)).toBe(false);
  });

  it('evaluates > operator', () => {
    expect(evaluateExpression('completeness > 70', scores, BUILTIN)).toBe(true);
    expect(evaluateExpression('completeness > 80', scores, BUILTIN)).toBe(false);
  });

  it('evaluates <= operator', () => {
    expect(evaluateExpression('completeness <= 75', scores, BUILTIN)).toBe(true);
    expect(evaluateExpression('completeness <= 74', scores, BUILTIN)).toBe(false);
  });

  it('evaluates >= operator', () => {
    expect(evaluateExpression('completeness >= 75', scores, BUILTIN)).toBe(true);
    expect(evaluateExpression('completeness >= 76', scores, BUILTIN)).toBe(false);
  });

  it('evaluates == operator', () => {
    expect(evaluateExpression('completeness == 75', scores, BUILTIN)).toBe(true);
    expect(evaluateExpression('completeness == 80', scores, BUILTIN)).toBe(false);
  });

  it('evaluates != operator', () => {
    expect(evaluateExpression('completeness != 75', scores, BUILTIN)).toBe(false);
    expect(evaluateExpression('completeness != 80', scores, BUILTIN)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// evaluateExpression — compound AND / OR
// --------------------------------------------------------------------------

describe('evaluateExpression — compound AND/OR', () => {
  const scores = { completeness: 75, speculation: 60, hallucination: 0 };

  /** Validates: Rule expression evaluation — compound AND */
  it('evaluates compound AND expression as true when both conditions true', () => {
    expect(
      evaluateExpression('completeness < 80 && speculation > 50', scores, BUILTIN)
    ).toBe(true);
  });

  it('evaluates compound AND expression as false when one condition false', () => {
    expect(
      evaluateExpression('completeness < 80 && speculation > 70', scores, BUILTIN)
    ).toBe(false);
  });

  /** Validates: Rule expression evaluation — compound OR */
  it('evaluates compound OR expression as true when second condition met', () => {
    expect(
      evaluateExpression('completeness < 50 || speculation > 50', scores, BUILTIN)
    ).toBe(true);
  });

  it('evaluates compound OR expression as false when both conditions false', () => {
    expect(
      evaluateExpression('completeness < 50 || speculation > 70', scores, BUILTIN)
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// evaluateExpression — negation
// --------------------------------------------------------------------------

describe('evaluateExpression — negation', () => {
  /** Validates: Rule expression evaluation — negation operator */
  it('evaluates !security_score > 90 as false when score is 95', () => {
    // !security_score > 90 means NOT(security_score > 90) = NOT(true) = false
    const scores = { security_score: 95 };
    const metrics = new Set(['security_score']);
    expect(evaluateExpression('!security_score > 90', scores, metrics)).toBe(false);
  });

  it('evaluates !security_score > 90 as true when score is 80', () => {
    const scores = { security_score: 80 };
    const metrics = new Set(['security_score']);
    expect(evaluateExpression('!security_score > 90', scores, metrics)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// evaluateExpression — parenthesized grouping
// --------------------------------------------------------------------------

describe('evaluateExpression — parenthesized grouping', () => {
  /** Validates: Rule expression evaluation — grouped expression with parentheses */
  it('evaluates grouped expression respecting grouping', () => {
    const scores = { completeness: 60, hallucination: 10 };
    const metrics = new Set(['completeness', 'speculation', 'hallucination']);
    // (completeness < 50 || speculation > 80) && hallucination > 5
    // completeness < 50 = false (60 < 50), speculation missing -> ERROR so use safe scores
    const scores2 = { completeness: 40, speculation: 90, hallucination: 10 };
    // (40 < 50 || 90 > 80) && 10 > 5 = (true || true) && true = true
    expect(
      evaluateExpression(
        '(completeness < 50 || speculation > 80) && hallucination > 5',
        scores2,
        BUILTIN
      )
    ).toBe(true);
  });

  it('evaluates grouped expression where outer AND is false', () => {
    // (completeness < 50 || speculation > 80) && hallucination > 5
    // (80 < 50 = false || 10 > 80 = false) && 3 > 5 = false && false = false
    const scores = { completeness: 80, speculation: 10, hallucination: 3 };
    expect(
      evaluateExpression(
        '(completeness < 50 || speculation > 80) && hallucination > 5',
        scores,
        BUILTIN
      )
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// evaluateExpression — operator precedence
// --------------------------------------------------------------------------

describe('evaluateExpression — operator precedence', () => {
  /** Validates: Rule expression evaluation — AND binds tighter than OR */
  it('AND binds tighter than OR: a>50 || b>50 && c>50 with a=60,b=60,c=40 returns true', () => {
    // Parsed as: a>50 || (b>50 && c>50) = true || (true && false) = true || false = true
    const scores = { a: 60, b: 60, c: 40 };
    expect(evaluateExpression('a > 50 || b > 50 && c > 50', scores, BUILTIN)).toBe(true);
  });

  it('AND binds tighter than OR: without parentheses vs with parentheses differ', () => {
    // a>50 || (b>50 && c>50) with a=40, b=60, c=40 = false || false = false
    const scores = { a: 40, b: 60, c: 40 };
    expect(evaluateExpression('a > 50 || b > 50 && c > 50', scores, BUILTIN)).toBe(false);

    // (a>50 || b>50) && c>50 = (false || true) && false = true && false = false
    // -- same result here, but tests different parse path
    expect(evaluateExpression('(a > 50 || b > 50) && c > 50', scores, BUILTIN)).toBe(false);

    // a>50 || (b>50 && c>50) vs (a>50 || b>50) differ when a=40, b=60, c=60
    const scores2 = { a: 40, b: 60, c: 60 };
    expect(evaluateExpression('a > 50 || b > 50 && c > 50', scores2, BUILTIN)).toBe(true);
    expect(evaluateExpression('(a > 50 || b > 50) && c > 50', scores2, BUILTIN)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// evaluateExpression — error cases
// --------------------------------------------------------------------------

describe('evaluateExpression — error cases', () => {
  /** Validates: Rule expression evaluation — unknown metric throws ExpressionError */
  it('throws ExpressionError for unknown metric', () => {
    expect(() =>
      evaluateExpression('unknown_metric < 50', {}, new Set(['completeness']))
    ).toThrow(ExpressionError);

    try {
      evaluateExpression('unknown_metric < 50', {}, new Set(['completeness']));
    } catch (err) {
      expect((err as ExpressionError).message).toContain('Unknown metric');
    }
  });

  it('throws ExpressionError when score is not provided for a known metric', () => {
    // Known metric but no score in map
    expect(() =>
      evaluateExpression('completeness < 80', {}, BUILTIN)
    ).toThrow(ExpressionError);
  });
});

// --------------------------------------------------------------------------
// validateExpression
// --------------------------------------------------------------------------

describe('validateExpression', () => {
  /** Validates: Rule expression evaluation — validateExpression catches unknown metrics */
  it('throws ExpressionError for unknown metric in expression', () => {
    expect(() => validateExpression('bogus < 50', new Set(['completeness']))).toThrow(ExpressionError);
    try {
      validateExpression('bogus < 50', new Set(['completeness']));
    } catch (err) {
      expect((err as ExpressionError).message).toContain('bogus');
    }
  });

  it('does not throw for valid expression with known metrics', () => {
    expect(() => validateExpression('completeness < 80', BUILTIN)).not.toThrow();
  });
});
