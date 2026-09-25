Group Face Picker training data
===============================

Statistics collection is controlled only from the JSX Settings dialog and is OFF by default.
When "Собирать статистику для обучения" is enabled, a successful face insertion stores:
- events/<event-id>.json  - the original explicit preference: chosen face > current face
- faces/<sha256>.jpg      - 320x320 cached face crops referenced by events

If Group Face Picker showed an automatic recommendation and you chose a different face, the same
event also stores the rejected recommended face. The updated trainer can then add one extra explicit
pair: chosen face > rejected recommendation. No other visible candidates are treated as rejected.

The event schema stays at version 1. Existing datasets need no conversion: old events remain valid,
and older trainers simply ignore the optional recommendation metadata in newer events.

The same face image is stored only once because filenames use SHA-256 content hashes.
Events use unique/idempotent IDs, so copying the same dataset more than once is safe.
A local collector.json is created automatically on the first saved event. It contains a random
instance id only (no hostname or username) and is not imported by the merge utility.

To combine statistics from several computers, copy each computer's complete training_data folder
and run, for example:

  merge_training_data.bat "D:\PC1\training_data" "E:\PC2\training_data"

The merge utility verifies hashes, copies only missing face crops and deduplicates events.
Do not manually rename files inside faces or events.


TRAINING A PERSONAL MODEL
=========================
1. Merge statistics from other computers with merge_training_data.bat.
2. Run train_personal_model.bat from the Group Face Picker root.
3. The first run creates runtime\training_venv and downloads the pretrained MobileNetV3-Small backbone.
4. Outputs are written to personal_model\:
   - personal_preference.onnx
   - personal_preference.json
   - training_report.md

The trainer removes duplicate exact pairs, excludes contradictory A>B / B>A pairs and tries to split
validation without sharing the same face crop between train and validation. The model is intended to
rank different frames of the same person. See the main README.md section "Обучение персональной модели".

Group Face Picker can use personal_model\personal_preference.onnx directly for preview recommendation.
Choose "My trained model" or the combined public+personal mode in the JSX Settings dialog.
