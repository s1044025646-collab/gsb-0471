import { BhError } from "./errors.js";
import type { Fraction } from "./types.js";

export const MAX_DECIMAL_PLACES = 12;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x === 0n ? 1n : x;
}

/**
 * 解析零到一的十进制字符串。
 * 仅接受普通十进制（如 "0.01"、"1"、".5"、"0"），
 * 不接受科学计数、NaN、Infinity、隐式空值。
 * 最多 12 位小数。返回既约整数比例。
 */
export function parseDecimal(input: unknown, fieldLabel = "value"): Fraction {
  if (typeof input !== "string") {
    throw new BhError(
      "INVALID_DECIMAL",
      `${fieldLabel} 必须是十进制字符串，收到 ${input === null ? "null" : typeof input}`
    );
  }
  const s = input.trim();
  if (s === "") {
    throw new BhError("INVALID_DECIMAL", `${fieldLabel} 不能为空字符串`);
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$|^\.[0-9]+$/.test(s)) {
    if (/[eE]/.test(s)) {
      throw new BhError(
        "SCIENTIFIC_NOTATION_NOT_ALLOWED",
        `${fieldLabel} 不接受科学计数法：${input}`
      );
    }
    throw new BhError("INVALID_DECIMAL", `${fieldLabel} 不是合法十进制字符串：${input}`);
  }
  const dot = s.indexOf(".");
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? "" : s.slice(dot + 1);
  if (fracPart.length > MAX_DECIMAL_PLACES) {
    throw new BhError(
      "TOO_MANY_DECIMALS",
      `${fieldLabel} 小数位数 ${fracPart.length} 超过上限 ${MAX_DECIMAL_PLACES}：${input}`
    );
  }
  const digits = intPart + fracPart;
  let num = BigInt(digits);
  const den = 10n ** BigInt(fracPart.length);
  if (num > den) {
    throw new BhError("OUT_OF_RANGE", `${fieldLabel} 必须在 [0,1] 区间：${input}`);
  }
  if (num === 0n) {
    return { num: 0n, den: 1n };
  }
  const g = gcd(num, den);
  num /= g;
  return { num, den: den / g };
}

export function reduce(num: bigint, den: bigint): Fraction {
  if (den <= 0n) throw new BhError("INTERNAL", "分数分母必须为正");
  if (num === 0n) return { num: 0n, den: 1n };
  const neg = num < 0n;
  let n = neg ? -num : num;
  const g = gcd(n, den);
  n /= g;
  return { num: neg ? -n : n, den: den / g };
}

export function cmpFrac(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

/** a*n/d 形式的分数（用于 m*p/i 与 i*alpha/m），返回既约结果 */
export function fracMulDiv(a: Fraction, n: bigint, d: bigint): Fraction {
  return reduce(a.num * n, a.den * d);
}

export function minFrac(a: Fraction, b: Fraction): Fraction {
  return cmpFrac(a, b) <= 0 ? a : b;
}

/**
 * 显示小数：若可在 12 位内整除则给精确有限小数（去尾零），
 * 否则给 12 位四舍五入小数并由调用方标注 rounded=true。
 */
export function toDisplay(f: Fraction, digits = MAX_DECIMAL_PLACES): { text: string; rounded: boolean } {
  const scale = 10n ** BigInt(digits);
  const scaled = f.num * scale;
  const q = scaled / f.den;
  const r = scaled % f.den;
  const rounded = r !== 0n;
  let int = q / scale;
  let frac = q % scale;
  if (rounded) {
    // 四舍五入（余数两倍与分母比较）
    if (r * 2n >= f.den) {
      frac += 1n;
      if (frac >= scale) {
        frac = 0n;
        int += 1n;
      }
    }
  }
  let fracStr = frac.toString().padStart(digits, "0");
  fracStr = fracStr.replace(/0+$/, "");
  const text = fracStr === "" ? int.toString() : `${int.toString()}.${fracStr}`;
  return { text, rounded };
}

export function fracToString(f: Fraction): string {
  return f.den === 1n ? f.num.toString() : `${f.num.toString()}/${f.den.toString()}`;
}

/** 稳定编号排序：按 UTF-16 码元字典序 */
export function compareId(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
