// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { isSensitive } from "../src/sensitive";
import { fieldInfo } from "../src/scanner";
import { fakeLayout } from "./setup-dom";

beforeEach(() => {
  fakeLayout();
  document.body.innerHTML = "";
});

function field(html: string): Element {
  document.body.innerHTML = html;
  return document.querySelector("[data-t]")!;
}

const POSITIVE: Array<[string, string]> = [
  ["password type", `<input data-t type="password">`],
  ["gift card number", `<label for="g">Gift card number</label><input data-t id="g">`],
  ["claim code", `<input data-t name="claimCode" placeholder="Enter claim code">`],
  ["redemption code", `<label for="r">Redemption code</label><input data-t id="r">`],
  ["one-time-code (otp kind)", `<input data-t autocomplete="one-time-code">`],
  ["current-password", `<input data-t autocomplete="current-password">`],
  ["new-password", `<input data-t autocomplete="new-password">`],
  ["cc-number", `<input data-t autocomplete="cc-number">`],
  ["section + cc-exp", `<input data-t autocomplete="section-pay billing cc-exp">`],
  ["cc-csc", `<input data-t autocomplete="cc-csc">`],
  ["name cardNumber", `<input data-t name="cardNumber">`],
  ["id card_number", `<input data-t id="card_number">`],
  ["name cardnumber", `<input data-t name="cardnumber">`],
  ["label Card number", `<label for="x">Card number</label><input data-t id="x">`],
  ["aria-label CVV", `<input data-t aria-label="CVV">`],
  ["name cvc", `<input data-t name="cvc">`],
  ["placeholder Security code", `<input data-t placeholder="Security code">`],
  ["label Social Security number", `<label>Social Security number <input data-t></label>`],
  ["name ssn", `<input data-t name="ssn">`],
  ["label Routing number", `<label for="r">Routing number</label><input data-t id="r">`],
  ["label Account number", `<label for="a">Account number</label><input data-t id="a">`],
  ["name acctNum", `<input data-t name="acctNum">`],
  ["label PIN", `<label for="p">PIN</label><input data-t id="p" inputmode="numeric">`],
  ["name pin_code", `<input data-t name="pin_code">`],
  ["aria-labelledby IBAN", `<span id="l">IBAN</span><input data-t aria-labelledby="l">`],
  ["placeholder Credit card", `<input data-t placeholder="Credit card">`],
  ["select labelled card number", `<label for="s">Card number</label><select data-t id="s"><option>1</option></select>`],
];

const NEGATIVE: Array<[string, string]> = [
  ["email", `<label for="e">Email</label><input data-t id="e" type="email" autocomplete="email">`],
  ["shipping address", `<label for="s">Shipping address</label><input data-t id="s" autocomplete="shipping street-address">`],
  ["spinach", `<label for="q">Spinach quantity</label><input data-t id="q" type="number">`],
  ["gift message", `<label for="m">Message for the card</label><input data-t id="m">`],
  ["promo search", `<input data-t name="q" placeholder="Search gifts">`],
  ["search q", `<input data-t name="q" placeholder="Search products">`],
  ["account email", `<input data-t aria-label="Account email">`],
  ["zip code", `<input data-t name="zipCode" placeholder="Zip code">`],
  ["card holder name", `<input data-t aria-label="Name on card" autocomplete="name">`],
  ["phone number", `<input data-t type="tel" aria-label="Phone number">`],
  ["promo code", `<input data-t placeholder="Promo code">`],
  ["card notes", `<textarea data-t aria-label="Card notes"></textarea>`],
  ["opinion", `<textarea data-t aria-label="Your opinion"></textarea>`],
  ["pinterest", `<input data-t name="pinterest_handle">`],
  ["username", `<input data-t autocomplete="username" name="user">`],
];

describe("isSensitive", () => {
  it.each(POSITIVE)("sensitive: %s", (_name, html) => {
    expect(isSensitive(field(html))).toBe(true);
  });

  it.each(NEGATIVE)("not sensitive: %s", (_name, html) => {
    expect(isSensitive(field(html))).toBe(false);
  });

  it("fieldInfo sets sensitive only when true", () => {
    expect(fieldInfo(field(`<input data-t type="password">`))!.sensitive).toBe(true);
    expect("sensitive" in fieldInfo(field(`<input data-t type="email">`))!).toBe(false);
  });

  it("never reads the value", () => {
    const el = field(`<input data-t name="card">`) as HTMLInputElement;
    Object.defineProperty(el, "value", { get() { throw new Error("value read"); }, configurable: true });
    expect(isSensitive(el)).toBe(false);
  });
});
