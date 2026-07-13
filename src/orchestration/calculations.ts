import type { CalculationCheck, CalculationLedger } from '../schemas/index.js';

interface Quantity {
  value: number;
  unit: string;
}

function unitPowers(unit: string): Map<string, number> {
  const powers = new Map<string, number>();
  let sign = 1;
  for (const token of unit.split(/([*/])/).map((part) => part.trim()).filter(Boolean)) {
    if (token === '*') { sign = 1; continue; }
    if (token === '/') { sign = -1; continue; }
    if (token !== '1') powers.set(token, (powers.get(token) ?? 0) + sign);
  }
  return new Map([...powers].filter(([, power]) => power !== 0));
}

function sameUnits(left: Map<string, number>, right: Map<string, number>): boolean {
  return left.size === right.size && [...left].every(([unit, power]) => right.get(unit) === power);
}

function formatUnits(powers: Map<string, number>): string {
  const numerator: string[] = [];
  const denominator: string[] = [];
  for (const [unit, power] of [...powers].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < Math.abs(power); i++) (power > 0 ? numerator : denominator).push(unit);
  }
  const top = numerator.join('*') || '1';
  return denominator.length ? `${top}/${denominator.join('/')}` : top;
}

function resultUnit(operation: CalculationLedger['steps'][number]['operation'], left: string, right: string): string | null {
  const leftPowers = unitPowers(left);
  const rightPowers = unitPowers(right);
  if (operation === 'ADD' || operation === 'SUBTRACT') return sameUnits(leftPowers, rightPowers) ? formatUnits(leftPowers) : null;
  const powers = new Map(leftPowers);
  for (const [unit, power] of rightPowers) {
    powers.set(unit, (powers.get(unit) ?? 0) + (operation === 'MULTIPLY' ? power : -power));
    if (powers.get(unit) === 0) powers.delete(unit);
  }
  return formatUnits(powers);
}

/** Recompute a declared ledger without eval/shell execution and report value/unit mismatches. */
export function evaluateCalculation(calculation: CalculationLedger): CalculationCheck {
  const values = new Map<string, Quantity>(calculation.inputs.map((input) => [input.id, { value: input.value, unit: input.unit }]));
  const issues: string[] = [];

  for (const step of calculation.steps) {
    const left = values.get(step.left);
    const right = values.get(step.right);
    if (!left || !right) {
      issues.push(`${step.id}: unknown operand reference`);
      continue;
    }
    if (step.operation === 'DIVIDE' && right.value === 0) {
      issues.push(`${step.id}: division by zero`);
      continue;
    }
    const expected = step.operation === 'ADD' ? left.value + right.value
      : step.operation === 'SUBTRACT' ? left.value - right.value
        : step.operation === 'MULTIPLY' ? left.value * right.value
          : left.value / right.value;
    const unit = resultUnit(step.operation, left.unit, right.unit);
    if (!unit) issues.push(`${step.id}: ${step.operation} requires matching units (${left.unit} vs ${right.unit})`);
    else if (!sameUnits(unitPowers(step.unit), unitPowers(unit))) issues.push(`${step.id}: unit ${step.unit} does not match ${unit}`);
    if (Math.abs(step.result - expected) > 1e-9 * Math.max(1, Math.abs(expected))) {
      issues.push(`${step.id}: result ${step.result} does not match ${expected}`);
    }
    values.set(step.id, { value: expected, unit: unit ?? step.unit });
  }

  if (!calculation.steps.some((step) => step.id === calculation.result_step)) {
    issues.push(`result_step: unknown step ${calculation.result_step}`);
  }
  return {
    calculation_id: calculation.id,
    claim_id: calculation.claim_id,
    status: issues.length ? 'FAIL' : 'PASS',
    issues,
  };
}
