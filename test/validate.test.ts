import { describe, expect, test } from "bun:test";
import { validateField, verhoeffCheckDigit, verhoeffValidate } from "../src/validate";

function validAadhaar(base11: string): string {
  return base11 + String(verhoeffCheckDigit(base11));
}

describe("aadhaar", () => {
  const good = validAadhaar("23456789012");

  test("valid number passes and is normalized", () => {
    const spaced = `${good.slice(0, 4)} ${good.slice(4, 8)} ${good.slice(8)}`;
    expect(validateField("aadhaar_number", spaced)).toEqual({ ok: true, value: good });
    expect(verhoeffValidate(good)).toBe(true);
  });

  test("single-digit typo fails the checksum", () => {
    const typo = good.slice(0, 5) + ((Number(good[5]) + 1) % 10) + good.slice(6);
    const res = validateField("aadhaar_number", typo);
    expect(res.ok).toBe(false);
  });

  test("wrong length and leading 0/1 rejected", () => {
    expect(validateField("aadhaar_number", "12345").ok).toBe(false);
    expect(validateField("aadhaar_number", validAadhaar("13456789012")).ok).toBe(false);
  });
});

describe("mobile", () => {
  test("normalizes +91 and spaces", () => {
    expect(validateField("mobile", "+91 98765 43210")).toEqual({ ok: true, value: "9876543210" });
  });
  test("rejects wrong start digit or length", () => {
    expect(validateField("mobile", "1234567890").ok).toBe(false);
    expect(validateField("mobile", "98765").ok).toBe(false);
  });
});

describe("pincode", () => {
  test("valid", () => expect(validateField("pincode", "110001")).toEqual({ ok: true, value: "110001" }));
  test("rejects leading zero and wrong length", () => {
    expect(validateField("pincode", "010001").ok).toBe(false);
    expect(validateField("pincode", "1100").ok).toBe(false);
  });
});

describe("dob", () => {
  test("normalizes formats to DD/MM/YYYY", () => {
    expect(validateField("dob", "5/8/1998")).toEqual({ ok: true, value: "05/08/1998" });
    expect(validateField("dob", "1998-08-05")).toEqual({ ok: true, value: "05/08/1998" });
  });
  test("rejects impossible or future dates", () => {
    expect(validateField("dob", "31/02/2000").ok).toBe(false);
    expect(validateField("dob", "01/01/2099").ok).toBe(false);
    expect(validateField("dob", "kal ka din").ok).toBe(false);
  });
});

describe("passthrough", () => {
  test("unknown keys pass trimmed", () => {
    expect(validateField("full_name", "  Ravi Kumar ")).toEqual({ ok: true, value: "Ravi Kumar" });
  });
  test("email", () => {
    expect(validateField("email", "Ravi@Example.COM")).toEqual({ ok: true, value: "ravi@example.com" });
    expect(validateField("email", "not-an-email").ok).toBe(false);
  });
});
