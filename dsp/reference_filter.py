"""Numerical specification of the listening-approved filter (NumPy float64).

This file contains no microphone recording or private learned profile. The
caller supplies independently vetted background means, deviations and phase.
"""
from __future__ import annotations
import numpy as np

NFFT = 2048
HOP = 256
MARGIN = 3.0
BACKGROUND_MULTIPLIER = 4.0
AMPLITUDE_FLOOR = 0.03


def interpolate_phase(table, position):
    table = np.asarray(table, dtype=np.float64)
    if table.ndim != 2 or len(table) < 1 or not np.isfinite(position):
        raise ValueError("A phase table and finite position are required")
    index = int(np.floor(position))
    fraction = position-index
    return table[index % len(table)]*(1-fraction)+table[(index+1) % len(table)]*fraction


def amplitude_mask(power, background, deviation, gain=1.0):
    power, background, deviation = [np.asarray(x, dtype=np.float64) for x in (power, background, deviation)]
    if power.shape != background.shape or power.shape != deviation.shape:
        raise ValueError("Power, background and deviation dimensions must agree")
    if any(np.any(~np.isfinite(x)) or np.any(x < 0) for x in (power, background, deviation)) or not np.isfinite(gain) or gain < 0:
        raise ValueError("Power profiles and gain must be finite and nonnegative")
    expected=(background+MARGIN*deviation)*gain*BACKGROUND_MULTIPLIER
    return np.maximum(AMPLITUDE_FLOOR, np.sqrt(np.divide(np.maximum(0, power-expected), power,
                      out=np.zeros_like(power), where=power > 1e-30)))


def analyze_frame(samples):
    samples=np.asarray(samples, dtype=np.float64)
    if samples.shape != (NFFT,) or np.any(~np.isfinite(samples)):
        raise ValueError("One finite 2048-sample frame is required")
    window=np.hanning(NFFT)
    spectrum=np.fft.rfft(samples*window)
    power=np.abs(spectrum)**2/window.sum()**2
    return spectrum, power


def filter_frame(samples, background, deviation, gain=1.0):
    spectrum,power=analyze_frame(samples)
    mask=amplitude_mask(power,background,deviation,gain)
    # Add this numerator with sum(Hann**2) normalization in the streaming host.
    return np.fft.irfft(spectrum*mask,n=NFFT)*np.hanning(NFFT)
