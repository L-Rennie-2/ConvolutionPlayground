import { audioContext, createWavBlob, loadAudioFile } from "./audio.js?v=2";
import { setWaveform, playWaveform, zoomIn, zoomOut, resetZoom } from "./waveforms.js";

const byId = id => document.getElementById(id);
// More control points allow finer adjustments across the logarithmic frequency axis.
let curve = new Float32Array(Number(byId("graphic-import-resolution").value));
const phaseCurve = new Float32Array(512);
let drawingCurve = false;
let lastCurvePoint = null;
let drawingPhase = false;
let lastPhasePoint = null;
let generatedBuffer = null;

// PCM16 WAV clips samples outside +/-1. Use IEEE float WAV when an IR has
// over-range peaks so the preview and saved file retain the generated samples.
function peakOfBuffer(buffer) {
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
    }
    return peak;
}

function createFloatWavBlob(buffer) {
    const channels = buffer.numberOfChannels;
    const bytesPerSample = 4;
    const blockAlign = channels * bytesPerSample;
    const dataSize = buffer.length * blockAlign;
    const wav = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wav);
    const writeText = (offset, value) => {
        for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true); // IEEE float PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 32, true);
    writeText(36, "data");
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let frame = 0; frame < buffer.length; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
            view.setFloat32(offset, buffer.getChannelData(channel)[frame], true);
            offset += bytesPerSample;
        }
    }
    return new Blob([wav], { type: "audio/wav" });
}

function createPreviewWavBlob(buffer) {
    const peak = peakOfBuffer(buffer);
    if (peak <= 1) return createWavBlob(buffer);

    // Browsers can clip over-range samples at the audio output. Scale only the
    // audition copy; the saved IR retains its original gain and peak values.
    const audition = audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    const scale = 0.98 / peak;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        const scaled = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) scaled[i] = samples[i] * scale;
        audition.copyToChannel(scaled, channel);
    }
    return createWavBlob(audition);
}

function downloadPreviewWav(buffer, filename) {
    const blob = peakOfBuffer(buffer) > 1 ? createFloatWavBlob(buffer) : createWavBlob(buffer);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function showImpulseWaveform(buffer, mediaSource) {
    const peaks = await setWaveform("output", buffer, mediaSource);
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
    }
    // Keep over-range peaks visible inside the waveform panel instead of
    // letting the drawing clip against its top and bottom edges.
    peaks.views.getView("zoomview").setAmplitudeScale(peak > 1 ? 1 / peak : 1);
}

function nextPowerOfTwo(value) {
    let size = 1;
    while (size < value) size *= 2;
    return size;
}

function fft(real, imag, inverse = false) {
    const length = real.length;
    let j = 0;

    for (let i = 1; i < length; i += 1) {
        let bit = length >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }

    for (let size = 2; size <= length; size *= 2) {
        const angle = (inverse ? 2 : -2) * Math.PI / size;
        const stepReal = Math.cos(angle);
        const stepImag = Math.sin(angle);
        const half = size / 2;

        for (let start = 0; start < length; start += size) {
            let wr = 1;
            let wi = 0;
            for (let k = 0; k < half; k += 1) {
                const even = start + k;
                const odd = even + half;
                const tr = wr * real[odd] - wi * imag[odd];
                const ti = wr * imag[odd] + wi * real[odd];
                real[odd] = real[even] - tr;
                imag[odd] = imag[even] - ti;
                real[even] += tr;
                imag[even] += ti;

                const nextWr = wr * stepReal - wi * stepImag;
                wi = wr * stepImag + wi * stepReal;
                wr = nextWr;
            }
        }
    }

    if (inverse) {
        for (let i = 0; i < length; i += 1) {
            real[i] /= length;
            imag[i] /= length;
        }
    }
}

function responseToImpulse(length, sampleRate, responseAtFrequency, outputLength = length) {
    const real = new Float64Array(length);
    const imag = new Float64Array(length);
    const half = length / 2;

    for (let bin = 0; bin <= half; bin += 1) {
        const frequency = bin * sampleRate / length;
        const [re, im] = responseAtFrequency(frequency);
        real[bin] = re;
        imag[bin] = im;
        if (bin > 0 && bin < half) {
            real[length - bin] = re;
            imag[length - bin] = -im;
        }
    }

    fft(real, imag, true);
    // Rotate the circular zero-time response to make a causal, centered IR.
    const samples = new Float32Array(outputLength);
    const firstIndex = (length - Math.floor(outputLength / 2)) % length;
    for (let i = 0; i < outputLength; i += 1) {
        samples[i] = real[(firstIndex + i) % length];
    }
    return samples;
}

function minimumPhaseSpectrum(length, sampleRate, responseAtFrequency) {
    const logMagnitude = new Float64Array(length);
    const phase = new Float64Array(length);
    const half = length / 2;

    // Build a real, even log-magnitude spectrum, then transform it into a
    // minimum-phase spectrum through the real cepstrum.
    for (let bin = 0; bin <= half; bin += 1) {
        const frequency = bin * sampleRate / length;
        const [real, imag] = responseAtFrequency(frequency);
        const magnitude = Math.max(Math.hypot(real, imag), 1e-12);
        logMagnitude[bin] = Math.log(magnitude);
        if (bin > 0 && bin < half) logMagnitude[length - bin] = logMagnitude[bin];
    }
    fft(logMagnitude, phase, true);

    for (let i = 1; i < half; i += 1) logMagnitude[i] *= 2;
    for (let i = half + 1; i < length; i += 1) logMagnitude[i] = 0;
    phase.fill(0);
    fft(logMagnitude, phase);

    const real = new Float64Array(length);
    const imag = new Float64Array(length);
    for (let bin = 0; bin < length; bin += 1) {
        const magnitude = Math.exp(logMagnitude[bin]);
        real[bin] = magnitude * Math.cos(phase[bin]);
        imag[bin] = magnitude * Math.sin(phase[bin]);
    }
    return { real, imag };
}

function minimumPhaseImpulse(length, sampleRate, responseAtFrequency, outputLength) {
    const { real, imag } = minimumPhaseSpectrum(length, sampleRate, responseAtFrequency);
    fft(real, imag, true);
    const samples = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i += 1) samples[i] = real[i];
    return samples;
}

function amplitudeAtFrequency(frequency, gains) {
    const minFrequency = 20;
    const maxFrequency = Math.min(20000, audioContext.sampleRate / 2);
    if (frequency <= minFrequency) return dbToAmplitude(gains[0]);
    if (frequency >= maxFrequency) return dbToAmplitude(gains[gains.length - 1]);
    const position = Math.log(frequency / minFrequency) /
        Math.log(maxFrequency / minFrequency) * (gains.length - 1);
    const lower = Math.floor(position);
    const fraction = position - lower;
    const lowAmplitude = dbToAmplitude(gains[lower]);
    const highAmplitude = dbToAmplitude(gains[lower + 1]);
    return lowAmplitude * (1 - fraction) + highAmplitude * fraction;
}

function phaseAtFrequency(frequency) {
    const minFrequency = 20;
    const maxFrequency = Math.min(20000, audioContext.sampleRate / 2);
    if (frequency <= minFrequency) return phaseCurve[0];
    if (frequency >= maxFrequency) return phaseCurve[phaseCurve.length - 1];
    const position = Math.log(frequency / minFrequency) /
        Math.log(maxFrequency / minFrequency) * (phaseCurve.length - 1);
    const lower = Math.floor(position);
    const fraction = position - lower;
    return phaseCurve[lower] * (1 - fraction) + phaseCurve[lower + 1] * fraction;
}

function dbToAmplitude(db) {
    return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}

// Read a loaded IR's magnitude spectrum into the editable graphic EQ curve.
function loadImpulseIntoCurve(buffer) {
    const mono = buffer.getChannelData(0);
    const fftSize = nextPowerOfTwo(mono.length);
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    for (let i = 0; i < mono.length; i += 1) real[i] = mono[i];
    fft(real, imag);

    const maxFrequency = Math.min(20000, audioContext.sampleRate / 2);
    let referenceMagnitude = 0;
    for (let bin = 1; bin <= fftSize / 2; bin += 1) {
        referenceMagnitude = Math.max(referenceMagnitude, Math.hypot(real[bin], imag[bin]));
    }
    referenceMagnitude = Math.max(referenceMagnitude, 1e-8);
    for (let i = 0; i < curve.length; i += 1) {
        const frequency = 20 * Math.pow(maxFrequency / 20, i / (curve.length - 1));
        const position = Math.min(fftSize / 2, Math.max(0, frequency * fftSize / buffer.sampleRate));
        const lowerBin = Math.floor(position);
        const upperBin = Math.min(fftSize / 2, lowerBin + 1);
        const fraction = position - lowerBin;
        const lowerMagnitude = Math.hypot(real[lowerBin], imag[lowerBin]);
        const upperMagnitude = Math.hypot(real[upperBin], imag[upperBin]);
        const magnitude = (lowerMagnitude * (1 - fraction) + upperMagnitude * fraction) / referenceMagnitude;
        curve[i] = Math.max(-96, Math.min(24, 20 * Math.log10(Math.max(magnitude, 1e-8))));
    }
    drawEqGraph();
}

function drawEqGraph() {
    const canvas = byId("eq-graph");
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;
    const left = 48;
    const right = 14;
    const top = 14;
    const bottom = 32;
    const graphWidth = width - left - right;
    const graphHeight = height - top - bottom;
    const minDb = -96;
    const maxDb = 24;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "11px Arial";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#334155";
    ctx.fillStyle = "#cbd5e1";

    for (const db of [-96, -72, -48, -24, 0, 12, 24]) {
        const y = top + (maxDb - db) / (maxDb - minDb) * graphHeight;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - right, y);
        ctx.stroke();
        ctx.fillText(`${db > 0 ? "+" : ""}${db} dB`, 5, y);
    }
    ctx.fillText("−∞ dB (mute)", 5, top + graphHeight - 10);

    const maxFrequency = Math.min(20000, audioContext.sampleRate / 2);
    const frequencies = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        .filter(frequency => frequency <= maxFrequency);
    for (const frequency of frequencies) {
        const x = left + Math.log(frequency / 20) / Math.log(maxFrequency / 20) * graphWidth;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + graphHeight);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`, x, top + graphHeight + 6);
    }

    ctx.beginPath();
    for (let i = 0; i < curve.length; i += 1) {
        const x = left + i / (curve.length - 1) * graphWidth;
        const y = Number.isFinite(curve[i])
            ? top + (maxDb - curve[i]) / (maxDb - minDb) * graphHeight
            : top + graphHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineWidth = 1;
}

function drawPhaseGraph() {
    const canvas = byId("phase-graph");
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = rect.width;
    const height = rect.height;
    const left = 72;
    const right = 14;
    const top = 12;
    const bottom = 30;
    const graphWidth = width - left - right;
    const graphHeight = height - top - bottom;
    const sampleRate = audioContext.sampleRate;
    const maxFrequency = Math.min(20000, sampleRate / 2);
    const outputLength = Math.round(Number(byId("graphic-length").value) * sampleRate);
    const phaseMode = byId("graphic-phase").value;
    const phasePoints = 512;
    const phases = new Float64Array(phasePoints);
    let minPhase = -180;
    let maxPhase = 180;

    if (phaseMode === "custom") {
        phases.set(phaseCurve);
        const range = Number(byId("graphic-phase-range").value);
        minPhase = -range;
        maxPhase = range;
    } else if (phaseMode === "linear") {
        // The generated linear-phase IR is centered in its selected duration.
        const delay = Math.floor(outputLength / 2) / sampleRate;
        for (let i = 0; i < phasePoints; i += 1) {
            const frequency = 20 * Math.pow(maxFrequency / 20, i / (phasePoints - 1));
            phases[i] = -2 * Math.PI * frequency * delay * 180 / Math.PI;
        }
    } else {
        // Estimate the minimum-phase curve on a fixed FFT grid so drawing stays responsive.
        const phaseFftLength = 4096;
        const { real, imag } = minimumPhaseSpectrum(
            phaseFftLength,
            sampleRate,
            frequency => [amplitudeAtFrequency(frequency, curve), 0]
        );
        const unwrapped = new Float64Array(phaseFftLength / 2 + 1);
        let previous = Math.atan2(imag[0], real[0]);
        unwrapped[0] = previous;
        for (let bin = 1; bin < unwrapped.length; bin += 1) {
            let current = Math.atan2(imag[bin], real[bin]);
            while (current - previous > Math.PI) current -= 2 * Math.PI;
            while (current - previous < -Math.PI) current += 2 * Math.PI;
            unwrapped[bin] = current;
            previous = current;
        }
        for (let i = 0; i < phasePoints; i += 1) {
            const frequency = 20 * Math.pow(maxFrequency / 20, i / (phasePoints - 1));
            const position = Math.min(phaseFftLength / 2, frequency * phaseFftLength / sampleRate);
            const lower = Math.floor(position);
            const upper = Math.min(phaseFftLength / 2, lower + 1);
            const fraction = position - lower;
            phases[i] = (unwrapped[lower] * (1 - fraction) + unwrapped[upper] * fraction) * 180 / Math.PI;
        }
    }

    if (phaseMode !== "custom") {
        minPhase = Infinity;
        maxPhase = -Infinity;
        for (const value of phases) {
            minPhase = Math.min(minPhase, value);
            maxPhase = Math.max(maxPhase, value);
        }
        if (maxPhase - minPhase < 1) {
            minPhase -= 180;
            maxPhase += 180;
        }
        const padding = (maxPhase - minPhase) * 0.06;
        minPhase -= padding;
        maxPhase += padding;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "11px Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let tick = 0; tick <= 4; tick += 1) {
        const value = maxPhase - (maxPhase - minPhase) * tick / 4;
        const y = top + graphHeight * tick / 4;
        ctx.strokeStyle = "#334155";
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - right, y);
        ctx.stroke();
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(`${Math.round(value).toLocaleString()} deg`, left - 7, y);
    }

    const frequencies = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        .filter(frequency => frequency <= maxFrequency);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const frequency of frequencies) {
        const x = left + Math.log(frequency / 20) / Math.log(maxFrequency / 20) * graphWidth;
        ctx.strokeStyle = "#334155";
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + graphHeight);
        ctx.stroke();
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`, x, top + graphHeight + 5);
    }

    ctx.beginPath();
    for (let i = 0; i < phases.length; i += 1) {
        const x = left + i / (phasePoints - 1) * graphWidth;
        const y = top + (maxPhase - phases[i]) / (maxPhase - minPhase) * graphHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    const customMode = phaseMode === "custom";
    canvas.classList.toggle("phase-editable", customMode);
    byId("phase-mode-label").textContent = customMode
        ? `Custom phase - draw here (range +/-${Number(byId("graphic-phase-range").value)} deg)`
        : phaseMode === "minimum" ? "Minimum phase (unwrapped)" : "Linear phase (unwrapped)";
}

function graphPoint(event) {
    const rect = byId("eq-graph").getBoundingClientRect();
    const left = 48;
    const right = 14;
    const top = 14;
    const bottom = 32;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left - left) / (rect.width - left - right)));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top - top) / (rect.height - top - bottom)));
    return {
        index: Math.round(x * (curve.length - 1)),
        db: y >= 0.999 ? -Infinity : (1 - y) * 120 - 96
    };
}

function phaseGraphPoint(event) {
    const rect = byId("phase-graph").getBoundingClientRect();
    const left = 72;
    const right = 14;
    const top = 12;
    const bottom = 30;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left - left) / (rect.width - left - right)));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top - top) / (rect.height - top - bottom)));
    const range = Number(byId("graphic-phase-range").value);
    return {
        index: Math.round(x * (phaseCurve.length - 1)),
        degrees: (1 - 2 * y) * range
    };
}

function drawPhaseCurveBetween(first, second) {
    const low = Math.min(first.index, second.index);
    const high = Math.max(first.index, second.index);
    for (let i = low; i <= high; i += 1) {
        const span = second.index - first.index;
        const ratio = span === 0 ? 0 : (i - first.index) / span;
        phaseCurve[i] = first.degrees + (second.degrees - first.degrees) * ratio;
    }
    drawEqGraph();
}

function drawCurveBetween(first, second) {
    const low = Math.min(first.index, second.index);
    const high = Math.max(first.index, second.index);
    for (let i = low; i <= high; i += 1) {
        const span = second.index - first.index;
        const ratio = span === 0 ? 0 : (i - first.index) / span;
        const amplitude = dbToAmplitude(first.db) * (1 - ratio) + dbToAmplitude(second.db) * ratio;
        curve[i] = amplitude === 0 ? -Infinity : 20 * Math.log10(amplitude);
    }
    drawEqGraph();
}

const eqCanvas = byId("eq-graph");
eqCanvas.addEventListener("pointerdown", event => {
    drawingCurve = true;
    lastCurvePoint = graphPoint(event);
    drawCurveBetween(lastCurvePoint, lastCurvePoint);
    eqCanvas.setPointerCapture(event.pointerId);
});
eqCanvas.addEventListener("pointermove", event => {
    if (!drawingCurve) return;
    const next = graphPoint(event);
    drawCurveBetween(lastCurvePoint, next);
    lastCurvePoint = next;
});
eqCanvas.addEventListener("pointerup", () => { drawingCurve = false; lastCurvePoint = null; });
eqCanvas.addEventListener("pointercancel", () => { drawingCurve = false; lastCurvePoint = null; });
const graphResizeObserver = new ResizeObserver(drawEqGraph);
graphResizeObserver.observe(eqCanvas);
drawEqGraph();

byId("graphic-phase").addEventListener("change", drawEqGraph);
byId("graphic-length").addEventListener("change", drawEqGraph);

byId("render-graphic").addEventListener("click", () => {
    const sampleRate = audioContext.sampleRate;
    const outputLength = Math.round(Number(byId("graphic-length").value) * sampleRate);
    const resolutionMultiplier = Number(byId("graphic-render-resolution").value);
    const fftLength = nextPowerOfTwo(outputLength * resolutionMultiplier);
    const phaseMode = byId("graphic-phase").value;
    const responseAtFrequency = frequency => {
        const magnitude = amplitudeAtFrequency(frequency, curve);
        if (phaseMode !== "custom") return [magnitude, 0];
        const radians = phaseAtFrequency(frequency) * Math.PI / 180;
        return [magnitude * Math.cos(radians), magnitude * Math.sin(radians)];
    };
    const impulse = phaseMode === "minimum"
        ? minimumPhaseImpulse(fftLength, sampleRate, responseAtFrequency, outputLength)
        : responseToImpulse(fftLength, sampleRate, responseAtFrequency, outputLength);

    generatedBuffer = audioContext.createBuffer(1, impulse.length, sampleRate);
    generatedBuffer.copyToChannel(impulse, 0);
    const previewBlob = createPreviewWavBlob(generatedBuffer);
    showImpulseWaveform(generatedBuffer, previewBlob).catch(error => console.error("Could not display generated IR:", error));
    byId("play-output").disabled = false;
    byId("save-graphic").disabled = false;
});

byId("graphic-import-resolution").addEventListener("change", event => {
    const previous = curve;
    const resized = new Float32Array(Number(event.target.value));
    for (let i = 0; i < resized.length; i += 1) {
        const position = i * (previous.length - 1) / (resized.length - 1);
        const lower = Math.floor(position);
        const upper = Math.min(previous.length - 1, lower + 1);
        const fraction = position - lower;
        const amplitude = dbToAmplitude(previous[lower]) * (1 - fraction) + dbToAmplitude(previous[upper]) * fraction;
        resized[i] = amplitude === 0 ? -Infinity : 20 * Math.log10(amplitude);
    }
    curve = resized;
    drawEqGraph();
});

byId("graphic-ir-file").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        const buffer = await loadAudioFile(file);
        loadImpulseIntoCurve(buffer);
        generatedBuffer = buffer;
        await showImpulseWaveform(buffer, file);
        byId("play-output").disabled = false;
        byId("save-graphic").disabled = false;
    } catch (error) {
        console.error("Could not load impulse response:", error);
        alert(`Could not load "${file.name}". ${error.message || error}`);
    }
});

byId("play-output").addEventListener("click", () => playWaveform("output"));
for (const [button, action] of [["output-zoom-in", zoomIn], ["output-zoom-out", zoomOut], ["output-reset-zoom", resetZoom]]) {
    byId(button).addEventListener("click", () => action("output"));
}

byId("save-graphic").addEventListener("click", () => {
    if (generatedBuffer) downloadPreviewWav(generatedBuffer, "graphic-eq-impulse-response.wav");
});
