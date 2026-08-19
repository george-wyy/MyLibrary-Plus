import assert from "node:assert/strict";

let formState = {};
let importError = null;
try {
  formState = await import("../src/mylibrary/web/static/annotation-form-state.mjs");
} catch (error) {
  importError = error;
}

function test(name, run) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function fakeForm(controls) {
  const attributes = new Map();
  return {
    elements: controls,
    isConnected: true,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
  };
}

test("annotation form lock helper is exported", () => {
  assert.equal(importError, null, importError?.message);
  assert.equal(typeof formState.lockAnnotationForm, "function");
});

test("pending note and tag forms lock every editable control", () => {
  for (const fieldName of ["note", "tags"]) {
    const controls = [
      { name: fieldName, disabled: false },
      { name: "save", disabled: false },
      { name: "cancel", disabled: false },
    ];
    const form = fakeForm(controls);

    formState.lockAnnotationForm(form);

    assert.equal(form.getAttribute("aria-busy"), "true");
    assert.equal(controls.every((control) => control.disabled), true);
  }
});

test("failed requests restore exact original control states", () => {
  const controls = [
    { name: "note", disabled: false },
    { name: "save", disabled: false },
    { name: "policy-locked", disabled: true },
  ];
  const form = fakeForm(controls);
  const pending = formState.lockAnnotationForm(form);

  assert.equal(pending.restore(), true);
  assert.deepEqual(controls.map((control) => control.disabled), [false, false, true]);
  assert.equal(form.getAttribute("aria-busy"), null);
});

test("stale restore never changes a detached or repurposed form", () => {
  const detachedControl = { name: "tags", disabled: false };
  const detachedForm = fakeForm([detachedControl]);
  const detached = formState.lockAnnotationForm(detachedForm);
  detachedForm.isConnected = false;

  assert.equal(detached.restore(), false);
  assert.equal(detachedControl.disabled, true);

  const reusedControl = { name: "note", disabled: false };
  const reusedForm = fakeForm([reusedControl]);
  const reused = formState.lockAnnotationForm(reusedForm);
  reusedForm.setAttribute("data-annotation-request", "newer-request");

  assert.equal(reused.restore(), false);
  assert.equal(reusedControl.disabled, true);
});
