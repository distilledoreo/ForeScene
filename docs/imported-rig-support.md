# Preserved imported character rigs

ForeScene can preserve an existing humanoid deformation rig when importing a GLB, embedded glTF, or FBX. In the poseable-character import dialog, choose **Use existing rig** to keep the source hierarchy, skinned meshes, skin indices, skin weights, inverse bind matrices, materials, and textures. ForeScene maps its persisted semantic `HumanPose` joints onto the source bone paths.

Mixamo and common Maya HumanIK deformation-joint names are mapped automatically. Generic humanoids expose a mapping review where required semantic joints can be corrected before the project is changed. The source skeleton and mapping are fingerprinted so stale mappings can be rejected during reload or package import.

The ordinary **Import 3D model** flow remains geometry-only. If it detects skinning, it warns that **Import poseable character** is the path that preserves the rig.

Imported animation clips are retained as metadata for inspection, but playback on the ForeScene timeline is intentionally deferred. Maya control rigs, constraints, IK handles, facial rigs, blendshape editing, retargeting, nonhumanoid skeletons, and multiple independent skeletons are outside this feature boundary.

`.fsrig` v2 packages carry imported mapping metadata and include the original source bytes when available. Project JSON stores only the compact binding; binary source data remains in the local model-asset store and package payloads.

