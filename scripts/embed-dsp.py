"""Update the generated DSP blocks in the standalone HTML after local edits."""
from pathlib import Path
import json
import re

root=Path(__file__).resolve().parent.parent
path=root/'index.html'
html=path.read_text()
blocks={
 'WASM':'globalThis.RHYTHM_WASM_BYTES=new Uint8Array('+json.dumps(list((root/'dsp/phase-filter.wasm').read_bytes()),separators=(',',':'))+');\n',
 'STREAM':(root/'dsp/background-stream.js').read_text(),
 'BACKGROUND':(root/'dsp/adaptive-background.js').read_text(),
 'ATTRIBUTION':(root/'dsp/echo-attribution.js').read_text(),
 'PERIODIC':(root/'dsp/periodic-note-onset.js').read_text(),
 'DETECTOR':(root/'dsp/background-detector.js').read_text(),
 'SAMPLE_RECORDER':(root/'js/sample-recorder.js').read_text(),
}
for name,source in blocks.items():
 begin='// GENERATED_'+name+'_BEGIN';end='// GENERATED_'+name+'_END'
 html,count=re.subn(re.escape(begin)+r'[\s\S]*?'+re.escape(end),lambda _:begin+'\n'+source+'\n'+end,html)
 if count!=1:raise RuntimeError(f'Expected one generated {name} block; found {count}')
path.write_text(html)
print('Embedded the local validated DSP sources and WASM module in index.html.')
