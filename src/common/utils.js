/**
 * Utility functions for timing, logging, and data structures
 */

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function deepClone(obj) {
  if (obj === undefined || obj === null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

let counter = 0;
export function generateClientId() {
  counter++;
  return `client-${Date.now()}-${counter}-${Math.random().toString(36).substring(2, 7)}`;
}

export class Logger {
  constructor(nodeId = 'GLOBAL', enabled = true) {
    this.nodeId = nodeId;
    this.enabled = enabled;
  }

  log(message, ...args) {
    if (this.enabled) {
      const ts = new Date().toISOString().substring(11, 23);
      console.log(`[${ts}] [Node ${this.nodeId}] ${message}`, ...args);
    }
  }

  warn(message, ...args) {
    if (this.enabled) {
      const ts = new Date().toISOString().substring(11, 23);
      console.warn(`[${ts}] [Node ${this.nodeId}] WARN: ${message}`, ...args);
    }
  }

  error(message, ...args) {
    const ts = new Date().toISOString().substring(11, 23);
    console.error(`[${ts}] [Node ${this.nodeId}] ERROR: ${message}`, ...args);
  }
}
