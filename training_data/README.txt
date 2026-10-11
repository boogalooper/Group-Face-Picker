Group Face Picker training data
===============================

Statistics collection is controlled only from the JSX Settings dialog and is OFF by default.
When "Собирать статистику для обучения" is enabled, a successful face insertion stores:
- <computer-id>/events/<event-id>.json  - the original explicit preference: chosen face > current face
- <computer-id>/faces/<sha256>.jpg      - 320x320 cached face crops referenced by events

If Group Face Picker showed an automatic recommendation and you chose a different face, the same
event also stores the rejected recommended face. The updated trainer can then add one extra explicit
pair: chosen face > rejected recommendation. No other visible candidates are treated as rejected.

The event schema stays at version 1. Existing datasets need no conversion: old events remain valid,
and older trainers simply ignore the optional recommendation metadata in newer events.

The same face image is stored only once because filenames use SHA-256 content hashes.
Events use unique/idempotent IDs, so copying the same dataset more than once is safe.
The computer ID is stable across application folder moves/copies on the same computer.
Windows uses a namespaced hash of MachineGuid; raw machine identifiers are not stored.

Copy each other computer's complete ID folder into this training_data folder.
The trainer automatically reads every immediate subfolder containing events, plus legacy
training_data/events and training_data/faces. No merge command is required.
Existing JSON/JPEG bytes, filenames and relative references remain unchanged.
To import old data, put its events and faces together in training_data/old-PC2/.
An old collector.json can remain in place; new collection does not use it.
When copying again, merge folder contents and preserve existing files.

Do not manually rename files inside faces or events.


TRAINING A PERSONAL MODEL
=========================
1. Copy ID folders from other computers into training_data (no conversion needed).
2. Run train_personal_model.bat from the Group Face Picker root.
3. The first run creates runtime\training_venv and downloads the pretrained MobileNetV3-Small backbone.
4. Outputs are written to personal_model\:
   - personal_preference.onnx
   - personal_preference.json
   - training_report.md

On the first real training run the trainer also creates:
   - training_data\diagnostic_holdout.json

Keep this file on the main training computer. It fixes a small diagnostic set so later reports can
measure progress on the same pairs. New events are not added to it automatically. Do not copy diagnostic_holdout.json from other computers.

The trainer removes duplicate exact pairs, excludes contradictory A>B / B>A pairs and tries to split
validation without sharing the same face crop between train and validation. It reports base
chosen>current accuracy separately from the harder chosen>rejected-recommendation accuracy. After
selecting L2 regularization using three grouped splits, the final ONNX head is trained again from scratch on all unique
non-contradictory pairs, so validation/diagnostic data are not permanently withheld from the working
model. The model is intended to rank different frames of the same person. See the main README.md
section "Обучение персональной модели".

Group Face Picker can use personal_model\personal_preference.onnx directly for preview recommendation.
Choose "My trained model" or the combined public+personal mode in the JSX Settings dialog.
