// Drive-mode executor (ARCHITECTURE §11). Writes what JustAsk was told to write; never reads a field's value.
import type { ActResult, ActSpec } from "@justask/shared";
import { normalize } from "./fingerprint";
import { isEditableHost } from "./scanner";
import { isSensitive } from "./sensitive";

const NOT_TYPEABLE = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color", "hidden"]);

type Win = Window & typeof globalThis;

function winOf(el: Element): Win {
  return (el.ownerDocument.defaultView ?? window) as Win;
}

function focus(el: Element) {
  (el as HTMLElement).focus?.({ preventScroll: false });
}

function fire(el: Element, type: "input" | "change", data: string | null = null) {
  const w = winOf(el);
  const ev =
    type === "input" && typeof w.InputEvent === "function"
      ? new w.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data })
      : new w.Event(type, { bubbles: true });
  el.dispatchEvent(ev);
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

function click(el: Element): boolean {
  focus(el);
  if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
  else el.dispatchEvent(new (winOf(el).MouseEvent)("click", { bubbles: true, cancelable: true, composed: true }));
  return true;
}

/** Native value setter, so framework-managed inputs (React) see the change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const w = winOf(el);
  const proto = el instanceof w.HTMLTextAreaElement ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("no value setter");
  setter.call(el, text);
}

function typeInto(el: Element, text: string): boolean {
  if (isDisabled(el)) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && NOT_TYPEABLE.has(el.type)) return false;
    if (el.readOnly) return false;
    focus(el);
    setNativeValue(el, text);
    fire(el, "input", text);
    fire(el, "change");
    return true;
  }
  if (!isEditableHost(el)) return false;
  focus(el);
  const doc = el.ownerDocument;
  const sel = winOf(el).getSelection?.();
  if (sel) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  let inserted = false;
  try {
    inserted = typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    el.textContent = text;
    fire(el, "input", text);
  }
  return true;
}

function choose(el: Element, option: string): boolean {
  if (!(el instanceof HTMLSelectElement) || el.disabled) return false;
  const want = normalize(option);
  const opts = Array.from(el.options);
  const label = (o: HTMLOptionElement) => normalize(o.label || o.text);
  let i = opts.findIndex((o) => !o.disabled && label(o) === want);
  if (i < 0) i = opts.findIndex((o) => !o.disabled && label(o).toLowerCase() === want.toLowerCase());
  if (i < 0) return false;
  focus(el);
  el.selectedIndex = i;
  fire(el, "input");
  fire(el, "change");
  return true;
}

function isSubmitter(el: Element, form: HTMLFormElement): el is HTMLButtonElement | HTMLInputElement {
  if (el instanceof HTMLButtonElement) return el.type === "submit" && el.form === form;
  if (el instanceof HTMLInputElement) return (el.type === "submit" || el.type === "image") && el.form === form;
  return false;
}

function pressEnter(el: Element) {
  focus(el);
  const K = winOf(el).KeyboardEvent;
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new K(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true }));
  }
}

function submit(el: Element): boolean {
  const form = (el as HTMLInputElement).form ?? el.closest("form");
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit(isSubmitter(el, form) ? el : undefined);
    return true;
  }
  pressEnter(el);
  return true;
}

/**
 * Perform one drive-mode action on an already-resolved element.
 * Refuses type/choose/submit on sensitive fields. `ok` means it ran without throwing.
 */
export function performAct(el: Element, spec: ActSpec): ActResult {
  try {
    if (spec.expect !== "click" && spec.expect !== "scroll" && isSensitive(el)) return { ok: false };
    switch (spec.expect) {
      case "click":
        return { ok: !isDisabled(el) && click(el) };
      case "type":
        return { ok: spec.text != null && typeInto(el, spec.text) };
      case "choose":
        return { ok: spec.option != null && choose(el, spec.option) };
      case "submit":
        return { ok: submit(el) };
      case "scroll":
        el.scrollIntoView({ block: "center", inline: "nearest" });
        return { ok: true };
      default:
        return { ok: false };
    }
  } catch {
    return { ok: false };
  }
}
