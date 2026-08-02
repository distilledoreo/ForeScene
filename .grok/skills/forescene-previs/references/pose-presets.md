# Pose presets

Use these semantic IDs in `blocking[].pose`, `cast[].defaultPose`, or motion staging `posePreset` values:

- `standing-neutral`
- `standing-alert`
- `standing-defensive`
- `walking`
- `running`
- `kneeling`
- `seated`
- `reaching`
- `holding-object`
- `shield-ready`
- `sword-ready`
- `injured`

Inside motion staging keyframes, `posePreset` is a control-intent hint. Poses interpolate as coarse previs guidance, not full biomechanical animation. Avoid cycling between unrelated presets rapidly. `walking` and `running` indicate silhouette/state; they do not generate complete locomotion mechanics. For facial acting, lip sync, hand contact, or precise prop interaction, classify the shot as `unsupported-performance`.
