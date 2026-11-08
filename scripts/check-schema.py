#!/usr/bin/env python3
"""Optional cross-check of Results JSON 1.0 files with a third-party JSON Schema implementation.
   pip3 install jsonschema   →   python3 scripts/check-schema.py results/dev/results.json [results/prod/results.json]"""
import json, sys
from jsonschema import Draft202012Validator

schema = json.load(open('schemas/results-1.0.schema.json', encoding='utf-8'))
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
failed = False
for path in sys.argv[1:]:
    with open(path, 'rb') as f:
        doc = json.loads(f.read().decode('utf-8'))
    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))
    print(f"{path}: {'OK по JSON Schema' if not errors else f'{len(errors)} ошибок'}")
    for e in errors[:20]:
        print('  ✖', '/'.join(map(str, e.absolute_path)) or '$', '—', e.message[:200])
    failed = failed or bool(errors)
sys.exit(1 if failed else 0)
