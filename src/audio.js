export const audioContext = new AudioContext();

export async function loadAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();

    return await audioContext.decodeAudioData(arrayBuffer);
}

export function createWavBlob(buffer) {
    const channelCount = buffer.numberOfChannels;
    const bytesPerSample = 2;
    const blockAlign = channelCount * bytesPerSample;
    const dataSize = buffer.length * blockAlign;
    const wav = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wav);

    function writeText(offset, value) {
        for (let i = 0; i < value.length; i += 1) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    }

    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeText(36, "data");
    view.setUint32(40, dataSize, true);

    const channels = Array.from(
        { length: channelCount },
        (_, channel) => buffer.getChannelData(channel)
    );
    let offset = 44;

    for (let frame = 0; frame < buffer.length; frame += 1) {
        for (let channel = 0; channel < channelCount; channel += 1) {
            const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
            const pcmSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(offset, pcmSample, true);
            offset += bytesPerSample;
        }
    }

    return new Blob([wav], { type: "audio/wav" });
}

export function downloadWav(buffer, filename) {
    const blob = createWavBlob(buffer);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
