# Self-Attention

Self-attention (also called intra-attention) relates different positions of
a single sequence in order to compute a representation of that sequence.
Instead of a recurrent unit passing a hidden state token by token, every
position directly queries every other position and forms a weighted sum
over their values.

## Mechanism

For each position, a query vector $q_i$ is compared against every key
vector $k_j$ via a dot product, scaled and passed through a softmax to get
attention weights, which are then used to combine the value vectors
$v_j$:

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
$$

Because the computation for every position is independent given $Q$, $K$,
$V$, this is fully parallelizable across the sequence — the main practical
advantage over recurrent alternatives.

## Why it works well

- Constant path length between any two positions ($O(1)$ vs. $O(n)$ for an
  RNN), which makes it much easier to learn long-range dependencies.
- Cheaper per-layer than a recurrent layer when the sequence length is
  smaller than the representation dimension, which is the common case for
  sentence-level NLP.
- The attention weights are directly inspectable, giving some interpretability
  into which tokens the model considers relevant to each other.

## Where it's used

The Transformer encoder uses self-attention where queries, keys, and values
all come from the same sequence. The decoder additionally uses masked
self-attention (each position can only attend to earlier positions) and
encoder-decoder attention (queries from the decoder, keys/values from the
encoder output).

See the Attention Is All You Need study note for the full multi-head
formulation.
