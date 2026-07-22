// Verhoeff checksum — the algorithm Aadhaar uses for its last digit.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function verhoeffValidate(num: string): boolean {
  let c = 0;
  const digits = num.split("").reverse().map(Number);
  for (let i = 0; i < digits.length; i++) {
    c = D[c]![P[i % 8]![digits[i]!]!]!;
  }
  return c === 0;
}

export function verhoeffCheckDigit(base: string): number {
  let c = 0;
  const digits = base.split("").reverse().map(Number);
  for (let i = 0; i < digits.length; i++) {
    c = D[c]![P[(i + 1) % 8]![digits[i]!]!]!;
  }
  return INV[c]!;
}

export type FieldCheck = { ok: true; value: string } | { ok: false; reason: string };

function parseDob(value: string): FieldCheck {
  let d: number, m: number, y: number;
  let match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return { ok: false, reason: "date not understood — use DD/MM/YYYY" };
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  if (!real) return { ok: false, reason: "not a real calendar date" };
  if (y < 1900 || date.getTime() > Date.now()) return { ok: false, reason: "year out of range" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return { ok: true, value: `${pad(d)}/${pad(m)}/${y}` };
}

/**
 * Validate + normalize a profile field before it is saved. Catches both user
 * typos and model hallucinations; unknown keys pass through trimmed.
 */
export function validateField(key: string, raw: string): FieldCheck {
  const k = key.toLowerCase();
  const value = raw.trim();
  if (!value) return { ok: false, reason: "empty value" };

  if (k.includes("aadhaar")) {
    const digits = value.replace(/[\s-]/g, "");
    if (!/^\d{12}$/.test(digits)) return { ok: false, reason: "Aadhaar must be exactly 12 digits" };
    if (/^[01]/.test(digits)) return { ok: false, reason: "Aadhaar never starts with 0 or 1" };
    if (!verhoeffValidate(digits)) {
      return { ok: false, reason: "checksum failed — one or more digits are wrong, ask the user to re-check" };
    }
    return { ok: true, value: digits };
  }

  if (k.includes("mobile") || k.includes("phone")) {
    const digits = value.replace(/[\s-]/g, "").replace(/^(\+?91|0)/, "");
    if (!/^[6-9]\d{9}$/.test(digits)) {
      return { ok: false, reason: "Indian mobile numbers are 10 digits starting with 6-9" };
    }
    return { ok: true, value: digits };
  }

  if (k.includes("pincode") || k === "pin") {
    const digits = value.replace(/\s/g, "");
    if (!/^[1-9]\d{5}$/.test(digits)) return { ok: false, reason: "PIN code must be 6 digits (cannot start with 0)" };
    return { ok: true, value: digits };
  }

  if (k === "dob" || k.includes("birth")) {
    return parseDob(value);
  }

  if (k.includes("email")) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return { ok: false, reason: "not a valid email address" };
    return { ok: true, value: value.toLowerCase() };
  }

  return { ok: true, value };
}
