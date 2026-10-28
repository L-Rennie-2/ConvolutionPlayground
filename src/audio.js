export const audioContext = new AudioContext();

export async function loadAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();

    return await audioContext.decodeAudioData(arrayBuffer);
}

export function playAudioBuffer(buffer) {
    const source = audioContext.createBufferSource();

    source.buffer = buffer;
    source.connect(audioContext.destination);

    source.start();

    return source;
}