# Arabic diacritization model

`model.onnx` and the three `*_id_map.json` files are libtashkeel's, unchanged,
from the `libtashkeel_base` 1.5.0 crate (© Musharraf Omer,
https://github.com/mush42/libtashkeel), licensed MIT OR Apache-2.0. They are
compiled into the Windows app by `src/neural/tashkeel.rs`, which puts the vowel
marks back on Arabic text before a natural voice reads it.
