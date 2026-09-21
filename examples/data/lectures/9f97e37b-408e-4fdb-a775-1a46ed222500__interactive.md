# Attention, interactively — a second lecture for the same paper

A paper's main lecture is `data/lectures/<paper_id>.md`. Any file named
`<paper_id>__<slug>.md` is an *additional* lecture for the same paper, and the study
view shows a picker next to the title. This file is `<id>__interactive.md`, so it
demonstrates two things the plain lecture does not: a second lecture variant, and a
live component embedded with a ` ```widget ` fence.

## Why a second lecture

The main note is a summary to come back to. This one is for the reading group: one
concept, one picture, one thing to play with. Both share the same PDF pane, the same
notes zoom, and the same annotation sidebar — highlights you make here stay attached
to this variant.

## Play with the temperature

The scaling factor in $\mathrm{softmax}(QK^\top/\sqrt{d_k})$ is doing real work: it
keeps one large logit from swallowing the whole distribution. Below, the same four
scores are softmaxed at a temperature you control.

```widget
src: softmax-temperature.html
height: 420
title: Interactive: softmax temperature
```

Drag the slider to the left (low temperature): one key takes almost all the weight.
Drag it to the right (high temperature): the distribution flattens toward uniform,
which is also what happens to attention when the logits are tiny relative to noise.

## How the widget works

- The component lives at
  `data/lectures/assets/<paper_id>/softmax-temperature.html` and is served by
  `GET /paper/{id}/lecture-asset/<path>` — only from that paper's asset directory, and
  only for the file types on the server's allow-list.
- The iframe is same-origin on purpose, so the component can use the vendored KaTeX
  fonts and read `localStorage['mylibrary-theme']`. Two messages are exchanged:
  the host posts `{type: "mylibrary-theme", theme}` whenever 夜览模式 changes (the
  widget follows it), and the widget posts `{type: "mylibrary-widget-height", height}`
  so the frame grows to fit its content.

## Recap of the main note

The main lecture covers why recurrence was dropped, the scaled dot-product formula,
multi-head attention, and [[positional-encoding]]. If the temperature slider made the
$\sqrt{d_k}$ factor click, the equivalent paragraph there is "Scaled Dot-Product
Attention".
