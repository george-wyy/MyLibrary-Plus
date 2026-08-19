let annotationRequestSequence = 0;

export function lockAnnotationForm(form) {
  annotationRequestSequence += 1;
  const requestToken = String(annotationRequestSequence);
  const controls = Array.from(form.elements || [])
    .filter((control) => typeof control?.disabled === "boolean")
    .map((control) => ({ control, disabled: control.disabled }));

  form.setAttribute("aria-busy", "true");
  form.setAttribute("data-annotation-request", requestToken);
  controls.forEach(({ control }) => { control.disabled = true; });

  return {
    requestToken,
    restore() {
      if (!form.isConnected || form.getAttribute("data-annotation-request") !== requestToken) return false;
      controls.forEach(({ control, disabled }) => { control.disabled = disabled; });
      form.removeAttribute("aria-busy");
      form.removeAttribute("data-annotation-request");
      return true;
    },
  };
}
