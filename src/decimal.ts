// 精确十进制解析：仅接受 [0,1] 的十进制字符串，最多 12 位小数。
// 内部统一用 SCALE = 10^12 的整数比例（BigInt）表示。

export const SCALE = 1_000_000_000_000n; // 10^12
export const MAX_FRACTION_DIGITS = 12;

export type DecimalErrorCode =
  | "EMPTY_VALUE"
  | "INVALID_FORMAT"
  | "TOO_MANY_DECIMALS"
  | "OUT_OF_RANGE";

export class DecimalError extends Error {
  readonly code: DecimalErrorCode;
  constructor(code: DecimalErrorCode, message: string) {
    super(message);
    this.name = "DecimalError";
    this.code = code;
  }
}

const DECIMAL_RE = /^(0(?:\.\d+)?|1(?:\.0+)?)$/;

// 将十进制字符串解析为 SCALE 整数比例。非法输入抛 DecimalError。
export function parseDecimal(raw: unknown): bigint {
  if (raw === null || raw === undefined) {
    throw new DecimalError("EMPTY_VALUE", "数值缺失（不允许隐式空值）");
  }
  if (typeof raw !== "string") {
    throw new DecimalError("INVALID_FORMAT", "数值必须是十进制字符串");
  }
  const s = raw.trim();
  if (s === "") {
    throw new DecimalError("EMPTY_VALUE", "数值为空字符串");
  }
  if (/[eE]/.test(s)) {
    throw new DecimalError("INVALID_FORMAT", `不接受科学计数法: "${raw}"`);
  }
  if (!DECIMAL_RE.test(s)) {
    throw new DecimalError(
      "INVALID_FORMAT",
      `不是合法的 [0,1] 十进制字符串: "${raw}"`,
    );
  }
  const dot = s.indexOf(".");
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  if (frac.length > MAX_FRACTION_DIGITS) {
    throw new DecimalError(
      "TOO_MANY_DECIMALS",
      `小数位超过 ${MAX_FRACTION_DIGITS} 位: "${raw}"`,
    );
  }
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPadded = (frac + "0".repeat(MAX_FRACTION_DIGITS)).slice(
    0,
    MAX_FRACTION_DIGITS,
  );
  const value = BigInt(intPart) * SCALE + BigInt(fracPadded || "0");
  if (value < 0n || value > SCALE) {
    throw new DecimalError("OUT_OF_RANGE", `数值超出 [0,1]: "${raw}"`);
  }
  return value;
}

// 既约分数字符串，如 4/75；整数则只给分子。
export function toFractionString(num: bigint, den: bigint): string {
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  return d === 1n ? n.toString() : `${n}/${d}`;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

// 显示用的小数字符串（最多 12 位，去尾零）。判定不依赖此显示。
export function toDisplayDecimal(value: bigint): string {
  const clamped = value < 0n ? 0n : value > SCALE ? SCALE : value;
  const intPart = clamped / SCALE;
  const frac = (clamped % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return frac === "" ? intPart.toString() : `${intPart}.${frac}`;
}
