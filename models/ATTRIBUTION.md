# Third-party assets

- **Brain model** (src/renderer/brain-mesh.js, simplified from models/brain-src/Brain_AS.stl):
  "Brain AS" by Agnieszka Starostecka, Wikimedia Commons,
  https://commons.wikimedia.org/wiki/File:Brain_AS.stl — licensed CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/). Simplified from ~3M to 80k triangles and recoloured.
- **Speaker verification model** (models/speaker-titanet-small.onnx): NVIDIA NeMo TitaNet-small, via the
  sherpa-onnx speaker-recognition model releases.

## Intent layer (models/intent)
- Sentence embeddings: BAAI/bge-small-en-v1.5 (MIT), int8 ONNX export by Xenova.
- Example remarks: Switchboard Dialog Act Corpus via cgpotts/swda (CC BY-NC-SA 3.0) and DailyDialog via
  li2017dailydialog/daily_dialog (CC BY-NC-SA 4.0). Non-commercial: fine for this personal build; swap in
  MASSIVE (CC BY 4.0) or Schema-Guided Dialogue (CC BY-SA 4.0) via scripts/intent-sources.mjs if that changes.
