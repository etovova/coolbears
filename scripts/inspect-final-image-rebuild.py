"""Inspect private v3 rebuild inputs without exposing traits, filenames or CIDs."""
from pathlib import Path
from collections import Counter
import csv, io, json, os, zipfile

base = Path(os.environ['RUNNER_TEMP']) / 'coolbears-verified-recovery'
recovery = base / 'recovery.zip'
if not recovery.exists():
    raise FileNotFoundError('Restored recovery.zip is missing')

with zipfile.ZipFile(recovery) as root_zip:
    with zipfile.ZipFile(io.BytesIO(root_zip.read('original_private_recovery.zip'))) as original:
        with zipfile.ZipFile(io.BytesIO(original.read('V3_Metadata_and_Reports.zip'))) as v3:
            prefix = 'CoolBears_10000_v3/'
            plan = json.loads(v3.read(prefix + 'generation_plan.json'))
            layers_report = json.loads(v3.read(prefix + 'reports/source_layers.json'))
            checksums = list(csv.DictReader(io.StringIO(v3.read(prefix + 'reports/image_checksums.csv').decode())))
        with zipfile.ZipFile(io.BytesIO(original.read('SourceLayers.zip'))) as layers_zip:
            source_names = [n for n in layers_zip.namelist() if not n.endswith('/')]

if len(plan) != 10000:
    raise ValueError('generation_plan.json must contain exactly 10000 entries')
if len(checksums) != 10000:
    raise ValueError('image_checksums.csv must contain exactly 10000 rows')
if len(layers_report) != 454:
    raise ValueError('source_layers.json must contain exactly 454 entries')

plan_key_sets = Counter(tuple(sorted(x.keys())) for x in plan)
attr_shapes = Counter()
for item in plan:
    attrs = item.get('attributes')
    if isinstance(attrs, dict):
        attr_shapes['dict'] += 1
    elif isinstance(attrs, list):
        attr_shapes['list'] += 1
    else:
        attr_shapes[type(attrs).__name__] += 1

layer_key_sets = Counter(tuple(sorted(x.keys())) for x in layers_report)
extensions = Counter(Path(x.get('relative_path', '')).suffix.lower() for x in layers_report)
source_extensions = Counter(Path(n).suffix.lower() for n in source_names)

result = {
    'schema': 1,
    'status': 'FINAL_IMAGE_REBUILD_INPUTS_PREFLIGHT_OK',
    'planEntries': len(plan),
    'checksumRows': len(checksums),
    'reportedSourceLayers': len(layers_report),
    'sourceArchiveFiles': len(source_names),
    'planKeySchemas': [{'keys': list(k), 'count': v} for k, v in sorted(plan_key_sets.items(), key=lambda kv: (-kv[1], kv[0]))],
    'attributeContainerShapes': dict(attr_shapes),
    'layerReportKeySchemas': [{'keys': list(k), 'count': v} for k, v in sorted(layer_key_sets.items(), key=lambda kv: (-kv[1], kv[0]))],
    'reportedLayerExtensions': dict(sorted(extensions.items())),
    'sourceArchiveExtensions': dict(sorted(source_extensions.items())),
    'traitsExposed': False,
    'cidsExposed': False,
    'walletOperations': False,
    'uploadsPerformed': False,
}

out = Path('build/final-image-rebuild-preflight')
out.mkdir(parents=True, exist_ok=True)
(out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
