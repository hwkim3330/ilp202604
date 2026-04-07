/**
 * gcl-to-yang.js — Convert solver boardConfigs entries to YANG instance-identifier YAML
 *
 * Produces YAML matching the format in keti-tsn-cli/lidar-tas/tas-enable.yaml:
 *   - /ietf-interfaces:interfaces/interface[name='PORT']/ieee802-dot1q-bridge:bridge-port/
 *     ieee802-dot1q-sched-bridge:gate-parameter-table
 *
 * Input:  portNum (string '1' or '2'), entries array, cycle_us
 * Output: YAML string for one port's TAS configuration
 */

import yaml from 'js-yaml';

const YANG_PATH_PREFIX =
  "/ietf-interfaces:interfaces/interface[name='PORT']/ieee802-dot1q-bridge:bridge-port/ieee802-dot1q-sched-bridge:gate-parameter-table";

/**
 * Convert a single port's GCL entries to YANG instance-identifier format
 *
 * @param {string} portNum - Physical port number ('1' or '2')
 * @param {Array} entries - GCL entries from solver boardConfigs
 *   Each entry: { index, gate_mask (string '10000000'), start_us, end_us, duration_us, note }
 * @param {number} cycle_us - Cycle time in microseconds
 * @returns {Array} YANG YAML structure (array of key-value objects)
 */
export function gclToYang(portNum, entries, cycle_us) {
  const path = YANG_PATH_PREFIX.replace('PORT', portNum);

  // Filter out 0-duration entries and merge consecutive same-mask entries
  const merged = mergeEntries(entries.filter(e => e.duration_us > 0));

  const cycleNs = Math.round(cycle_us * 1000);

  const gateControlEntries = merged.map((entry, idx) => {
    const maskInt = parseInt(entry.gate_mask, 2);
    const durationNs = Math.round(entry.duration_us * 1000);

    return {
      index: idx,
      'operation-name': 'set-gate-states',
      'gate-states-value': maskInt,
      'time-interval-value': durationNs
    };
  });

  const yangValue = {
    'gate-enabled': true,
    'admin-gate-states': 255,
    'admin-cycle-time': {
      numerator: cycleNs,
      denominator: 1000000000
    },
    'admin-base-time': {
      seconds: 0,
      nanoseconds: 0
    },
    'admin-control-list': {
      'gate-control-entry': gateControlEntries
    },
    'config-change': true
  };

  return [{ [path]: yangValue }];
}

/**
 * Merge consecutive entries with the same gate mask
 */
function mergeEntries(entries) {
  if (entries.length === 0) return [];

  const merged = [];
  let current = { ...entries[0] };

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].gate_mask === current.gate_mask) {
      current.duration_us += entries[i].duration_us;
      current.end_us = entries[i].end_us;
    } else {
      merged.push(current);
      current = { ...entries[i] };
    }
  }
  merged.push(current);
  return merged;
}

/**
 * Convert full boardConfigs + portMap to YANG YAML string
 *
 * @param {Object} boardConfigs - Solver result boardConfigs
 * @param {Object} portMap - { linkId: portNum } e.g. { l_swrear_acu: '1' }
 * @returns {string} Complete YANG YAML string
 */
export function boardConfigsToYaml(boardConfigs, portMap) {
  const allItems = [];

  for (const [linkId, portNum] of Object.entries(portMap)) {
    // Find the link's entries in boardConfigs
    for (const [swId, swCfg] of Object.entries(boardConfigs)) {
      const portCfg = swCfg.ports[linkId];
      if (portCfg) {
        const items = gclToYang(portNum, portCfg.entries, swCfg.cycle_time_us);
        allItems.push(...items);
      }
    }
  }

  if (allItems.length === 0) {
    throw new Error('No mapped ports found in boardConfigs');
  }

  return yaml.dump(allItems, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false
  });
}

/**
 * Get summary of what will be configured
 */
export function getConfigSummary(boardConfigs, portMap) {
  const summary = [];

  for (const [linkId, portNum] of Object.entries(portMap)) {
    for (const [swId, swCfg] of Object.entries(boardConfigs)) {
      const portCfg = swCfg.ports[linkId];
      if (portCfg) {
        const merged = mergeEntries(portCfg.entries.filter(e => e.duration_us > 0));
        summary.push({
          port: portNum,
          link: linkId,
          switch: swId,
          to: portCfg.to,
          entries: merged.length,
          cycle_us: swCfg.cycle_time_us
        });
      }
    }
  }

  return summary;
}
