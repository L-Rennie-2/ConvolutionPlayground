export function convolve(input, impulse) {
    const outputLength = input.length + impulse.length - 1;
    const output = new Float32Array(outputLength);

    for (let n = 0; n < outputLength; n++) {
        let sum = 0;

        const start = Math.max(0, n - impulse.length + 1);
        const end = Math.min(n, input.length - 1);

        for (let k = start; k <= end; k++) {
            sum += input[k] * impulse[n - k];
        }

        output[n] = sum;
    }

    return output;
}

export function normalise(samples, targetPeak = 0.99) {
    let peak = 0;

    for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample));
    }

    if (peak === 0) {
        return new Float32Array(samples);
    }

    const gain = targetPeak / peak;

    return Float32Array.from(
        samples,
        sample => sample * gain
    );
}