// The Mac's default input and output devices right now (names and transport), for labelling recordings and tests.
import { execFileSync } from 'child_process';

export function audioDevices() {
  try {
    const out = execFileSync('system_profiler', ['SPAudioDataType', '-json'], { encoding: 'utf8' });
    const items = JSON.parse(out).SPAudioDataType?.[0]?._items || [];
    const find = (key) => { const d = items.find((x) => x[key] === 'spaudio_yes'); return d ? { name: d._name, transport: (d.coreaudio_device_transport || '').replace('coreaudio_device_type_', ''), channels: d[key === 'coreaudio_default_audio_input_device' ? 'coreaudio_device_input' : 'coreaudio_device_output'] } : null; };
    return { input: find('coreaudio_default_audio_input_device'), output: find('coreaudio_default_audio_output_device') };
  } catch { return { input: null, output: null }; }
}
