// src/partitionedConvolution.js

// Radix-2 FFT
function fft(real, imag, inverse = false) {
    const n = real.length;

    // Bit-reversal permutation
    let j = 0;

    for (let i = 1; i < n; i++) {
        let bit = n >> 1;

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

    // FFT butterfly stages
    for (let size = 2; size <= n; size *= 2) {
        const halfSize = size / 2;
        const angle = (inverse ? 2 : -2) * Math.PI / size;

        const wMulReal = Math.cos(angle);
        const wMulImag = Math.sin(angle);

        for (let start = 0; start < n; start += size) {
            let wReal = 1;
            let wImag = 0;

            for (let k = 0; k < halfSize; k++) {
                const even = start + k;
                const odd = even + halfSize;

                const tReal =
                    wReal * real[odd] - wImag * imag[odd];

                const tImag =
                    wReal * imag[odd] + wImag * real[odd];

                const eReal = real[even];
                const eImag = imag[even];

                real[even] = eReal + tReal;
                imag[even] = eImag + tImag;

                real[odd] = eReal - tReal;
                imag[odd] = eImag - tImag;

                const nextWReal =
                    wReal * wMulReal - wImag * wMulImag;

                wImag =
                    wReal * wMulImag + wImag * wMulReal;

                wReal = nextWReal;
            }
        }
    }

    // Normalise inverse FFT
    if (inverse) {
        for (let i = 0; i < n; i++) {
            real[i] /= n;
            imag[i] /= n;
        }
    }
}

// Partitioned FFT convolution using overlap-add.
export function convolve(input, impulse) {
    const N = input.length;
    const M = impulse.length;

    if (N === 0 || M === 0) {
        return new Float32Array(0);
    }

    // Partition size. FFT size must be twice the partition size.
    const B = 256;
    const fftSize = B * 2;

    const outputLength = N + M - 1;
    const output = new Float32Array(outputLength);

    const inputBlocks = Math.ceil(N / B);
    const partitionCount = Math.ceil(M / B);

    // Precalculate the FFT of each impulse-response partition.
    const impulseSpectra = [];

    for (let p = 0; p < partitionCount; p++) {
        const real = new Float64Array(fftSize);
        const imag = new Float64Array(fftSize);

        for (let i = 0; i < B; i++) {
            const index = p * B + i;

            if (index < M) {
                real[i] = impulse[index];
            }
        }

        fft(real, imag);

        impulseSpectra.push({ real, imag });
    }

    // Frequency-domain delay line for input blocks.
    const inputSpectra = new Array(partitionCount);

    // Overlap from the previous output block.
    let overlap = new Float64Array(B);

    // Process additional zero blocks to flush the convolution tail.
    const totalBlocks = inputBlocks + partitionCount - 1;

    for (let block = 0; block < totalBlocks; block++) {
        const inputReal = new Float64Array(fftSize);
        const inputImag = new Float64Array(fftSize);

        // Load the current input block.
        if (block < inputBlocks) {
            for (let i = 0; i < B; i++) {
                const index = block * B + i;

                if (index < N) {
                    inputReal[i] = input[index];
                }
            }
        }

        // Transform current input block.
        fft(inputReal, inputImag);

        // Store its spectrum in the circular delay line.
        inputSpectra[block % partitionCount] = {
            real: inputReal,
            imag: inputImag
        };

        // Accumulate the frequency-domain products.
        const sumReal = new Float64Array(fftSize);
        const sumImag = new Float64Array(fftSize);

        for (let p = 0; p < partitionCount; p++) {
            const inputBlockIndex = block - p;

            if (inputBlockIndex < 0) continue;

            const X = inputSpectra[
                inputBlockIndex % partitionCount
            ];

            const H = impulseSpectra[p];

            for (let k = 0; k < fftSize; k++) {
                // Complex multiplication: X * H
                sumReal[k] +=
                    X.real[k] * H.real[k] -
                    X.imag[k] * H.imag[k];

                sumImag[k] +=
                    X.real[k] * H.imag[k] +
                    X.imag[k] * H.real[k];
            }
        }

        // Return to the time domain.
        fft(sumReal, sumImag, true);

        // Overlap-add and write the first half of this block.
        const outputOffset = block * B;

        for (let i = 0; i < B; i++) {
            const index = outputOffset + i;

            if (index < outputLength) {
                output[index] = sumReal[i] + overlap[i];
            }
        }

        // Save the second half for the next block.
        const nextOverlap = new Float64Array(B);

        for (let i = 0; i < B; i++) {
            nextOverlap[i] = sumReal[B + i];
        }

        overlap = nextOverlap;
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