# Positional Encoding

Self-attention treats its input as an unordered set — swapping two tokens'
positions doesn't change the attention computation at all. Since word order
obviously matters, the Transformer needs some other way to inject position
information, and it does so by adding a positional encoding vector to each
token embedding before the first layer.

## The sinusoidal formula

The original paper uses fixed (non-learned) sinusoids of different
frequencies, one pair per pair of embedding dimensions:

$$
PE_{(pos,\,2i)} = \sin\!\left(\frac{pos}{10000^{2i/d_{model}}}\right), \qquad
PE_{(pos,\,2i+1)} = \cos\!\left(\frac{pos}{10000^{2i/d_{model}}}\right)
$$

where $pos$ is the token's position in the sequence and $i$ indexes the
embedding dimension. Low dimensions oscillate quickly (short wavelength),
high dimensions oscillate slowly (long wavelength) — together they form a
kind of binary-clock encoding of position.

## Why sinusoids instead of a learned embedding

The paper argues (and shows experimentally) that this fixed scheme performs
about as well as a learned positional embedding, but has one extra property:
because $PE_{pos+k}$ can be expressed as a linear function of $PE_{pos}$, the
model can more easily learn to attend by *relative* position, and it can in
principle extrapolate to sequence lengths longer than anything seen during
training.

## Later variants

Follow-up work replaced this with learned absolute position embeddings
(BERT), relative position biases (T5, ALiBi), and rotary embeddings (RoPE,
used in most modern LLMs) — worth comparing against this original sinusoidal
version.
