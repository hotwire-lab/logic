import React, { useRef } from 'react';
import { CHANNELS, PinForceMode, PinPullMode, StatusTelemetry } from '../protocol/types';

export interface ChannelUiState {
  mode: PinForceMode;
  pull: PinPullMode;
  protect: boolean;
}

interface ChannelStripProps {
  connected: boolean;
  telemetry: StatusTelemetry;
  channelConfigs: ChannelUiState[];
  onForceChannel: (ch: number, mode: PinForceMode, pull: PinPullMode, protect?: boolean) => void;
}

export const ChannelStrip: React.FC<ChannelStripProps> = ({
  connected,
  telemetry,
  channelConfigs,
  onForceChannel,
}) => {
  const pulseRestoreRef = useRef<Map<number, { mode: PinForceMode; pull: PinPullMode }>>(new Map());

  const handlePulseDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    ch: number,
    physHigh: boolean,
    cfg: ChannelUiState
  ) => {
    if (!connected) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointerId
    }
    if (!pulseRestoreRef.current.has(ch)) {
      pulseRestoreRef.current.set(ch, { mode: cfg.mode, pull: cfg.pull });
    }
    // Force the opposite of the live physical state
    const targetMode: PinForceMode = physHigh ? 1 : 2;
    onForceChannel(ch, targetMode, cfg.pull, cfg.protect);
  };

  const handlePulseEnd = (ch: number, cfg: ChannelUiState, hasContention: boolean) => {
    const prior = pulseRestoreRef.current.get(ch);
    if (!prior) return;
    pulseRestoreRef.current.delete(ch);
    if (hasContention) return;
    onForceChannel(ch, prior.mode, prior.pull, cfg.protect);
  };

  return (
    <aside className="channel-strip" aria-label="8-channel tri-state force controls">
      <div className="channel-strip-header">
        <span>CH / GPIO</span>
        <span>LIVE</span>
        <span>FORCE</span>
        <span>PULSE</span>
        <span>PULL</span>
      </div>

      <div className="channel-rows">
        {CHANNELS.map((meta) => {
          const bit = 1 << meta.ch;
          const cfg = channelConfigs[meta.ch] ?? { mode: 0, pull: 0, protect: true };
          const physHigh = (telemetry.physicalLevels & bit) !== 0;
          const forceActive = (telemetry.forceEnableMask & bit) !== 0;
          const forcedHigh = (telemetry.forcedLevels & bit) !== 0;
          const hasContention = (telemetry.contentionMask & bit) !== 0;

          const effectiveMode: PinForceMode = forceActive ? (forcedHigh ? 2 : 1) : cfg.mode;
          const isZMode = effectiveMode === 0;

          return (
            <div
              key={meta.ch}
              className={`channel-row ${hasContention ? 'channel-row-short' : ''}`}
            >
              <div className="ch-id-cell">
                <span className="ch-color-bar" style={{ backgroundColor: meta.color }} />
                <div className="ch-labels">
                  <span className="ch-name">{meta.label}</span>
                  <span className="ch-gpio">GPIO {meta.gpio}</span>
                </div>
              </div>

              <div className="ch-live-cell">
                {hasContention ? (
                  <span className="live-badge live-short" title="Bus conflict / short circuit >20ms">
                    SHORT!
                  </span>
                ) : (
                  <span
                    className={`live-badge ${physHigh ? 'live-high' : 'live-low'}`}
                    title={`Physical level: ${physHigh ? 'HIGH (3.3V)' : 'LOW (0V)'}`}
                  >
                    {physHigh ? '1' : '0'}
                  </span>
                )}
              </div>

              <div className="ch-force-cell">
                <div className="seg-group" role="group" aria-label={`${meta.label} tri-state mode`}>
                  <button
                    type="button"
                    disabled={!connected}
                    className={`seg-btn ${effectiveMode === 0 ? 'active active-z' : ''}`}
                    onClick={() => onForceChannel(meta.ch, 0, cfg.pull, cfg.protect)}
                    title={`Release ${meta.label} to High-Z Input`}
                  >
                    Z
                  </button>
                  <button
                    type="button"
                    disabled={!connected}
                    className={`seg-btn ${effectiveMode === 1 ? 'active active-low' : ''}`}
                    onClick={() => onForceChannel(meta.ch, 1, cfg.pull, cfg.protect)}
                    title={`Force ${meta.label} LOW (0V)`}
                  >
                    0
                  </button>
                  <button
                    type="button"
                    disabled={!connected}
                    className={`seg-btn ${effectiveMode === 2 ? 'active active-high' : ''}`}
                    onClick={() => onForceChannel(meta.ch, 2, cfg.pull, cfg.protect)}
                    title={`Force ${meta.label} HIGH (3.3V)`}
                  >
                    1
                  </button>
                </div>
              </div>

              <div className="ch-pulse-cell">
                <button
                  type="button"
                  disabled={!connected}
                  className="btn-pulse"
                  onPointerDown={(e) => handlePulseDown(e, meta.ch, physHigh, cfg)}
                  onPointerUp={() => handlePulseEnd(meta.ch, cfg, hasContention)}
                  onPointerCancel={() => handlePulseEnd(meta.ch, cfg, hasContention)}
                  onLostPointerCapture={() => handlePulseEnd(meta.ch, cfg, hasContention)}
                  title={`Hold to pulse ${meta.label} to ${physHigh ? '0' : '1'}, release to restore`}
                >
                  ⚡
                </button>
              </div>

              <div className="ch-pull-cell">
                <div className="seg-group seg-pull" role="group" aria-label={`${meta.label} pull resistor`}>
                  {(
                    [
                      { pull: 0, label: '-', title: 'Floating (No pull)' },
                      { pull: 1, label: 'PU', title: 'Internal Pull-Up (~45 kΩ)' },
                      { pull: 2, label: 'PD', title: 'Internal Pull-Down (~45 kΩ)' },
                    ] as Array<{ pull: PinPullMode; label: string; title: string }>
                  ).map((opt) => (
                    <button
                      key={opt.pull}
                      type="button"
                      title={opt.title}
                      disabled={!connected || !isZMode}
                      className={`seg-btn ${cfg.pull === opt.pull ? 'active' : ''}`}
                      onClick={() => onForceChannel(meta.ch, 0, opt.pull, cfg.protect)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
};
