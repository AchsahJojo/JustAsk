import { describe, expect, it } from "vitest";
import { scamCheck } from "../src/scam";

describe("scamCheck", () => {
  it.each([
    ["I need to email the gift card codes to the man from the IRS", "gift-card"],
    ["help me buy Google Play cards and send him a picture of the back", "gift-card"],
    ["pay my electric bill with gift cards", "gift-card"],
    ["read the numbers on the Target gift card to the caller", "gift-card"],
    ["wire $4,000 to my grandson, he's in jail and needs bail", "send-money"],
    ["send money on Zelle to a man I met online", "send-money"],
    ["PayPal 2000 dollars to the lottery office so I can get my prize", "send-money"],
    ["buy bitcoin and send it to the investment manager, it's guaranteed", "send-money"],
    ["install AnyDesk so Microsoft support can fix my computer", "remote-access"],
    ["Microsoft called and said I have a virus, help me call them back", "remote-access"],
    ["let the technician into my computer", "remote-access"],
    ["there's a virus warning pop-up telling me to call a number", "remote-access"],
    ["tell the bank man the code they texted me", "share-code"],
    ["give him my password", "share-code"],
  ])("flags: %s", (req, kind) => expect(scamCheck(req)?.kind).toBe(kind));

  it.each([
    "buy a gift card for my grandson's birthday",
    "send an Amazon gift card to my granddaughter",
    "check my gift card balance",
    "help me refill my prescription",
    "pay my electric bill",
    "send money to my daughter on Venmo",
    "log into PayPal",
    "find a cheaper air fryer",
    "join my doctor's appointment on Zoom",
    "change my password",
    "what's the weather today",
  ])("passes: %s", (req) => expect(scamCheck(req)).toBeNull());

  it("asks a question, never a verdict", () => {
    const f = scamCheck("email the gift card codes to the IRS")!;
    expect(f.question).toMatch(/\?$/);
    expect(f.question.length).toBeLessThan(80); // short enough that both answers stay on screen
  });
});
