#!/usr/bin/env node
/*
 * Enhanced California SOS Business Search and Enrichment Service
 * Combines Node.js browser automation for cookies and API interactions
 * with Python-style XLSX processing, PDF parsing, Enformion enrichment,
 * confidence scoring, and logging to CSV/JSON/HTML viewer.
 *
 * Requirements:
 * npm install playwright pdf-parse xlsx axios yargs
 * npx playwright install chromium
 *
 * Usage:
 * node enhanced-ca-sos-enrich.js --xlsx "input.xlsx" --out "out" [--ap-name "enformion-name" --ap-password "enformion-pass"] [--max-rows 10] [--sleep 0.5] [--log-level DEBUG]
 *
 * CHANGELOG (Enhanced Version 2025-09-16):
 * - Added retry logic with exponential backoff for API calls
 * - Added progress tracking for large datasets
 * - Enhanced PDF parsing with multiple extraction strategies
 * - Improved manager/member detection with better person vs entity logic
 * - Added data validation and cleanup utilities
 * - Enhanced error handling with context and recovery
 * - Added memory usage monitoring
 * - Improved field detection and name normalization
 * - Better address parsing and standardization
 * - Enhanced confidence scoring with additional factors
 * - Added configuration validation
 * - Improved CSV output formatting and escaping
 * - Better handling of edge cases in PDF text extraction
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');
const axios = require('axios');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Optional PDF text extraction
let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  console.warn('[WARN] pdf-parse not installed. PDF text extraction disabled.');
}

// Logging levels
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};

// Global logger
let currentLogLevel = LOG_LEVELS.DEBUG;
function setLogLevel(level) {
  currentLogLevel = LOG_LEVELS[level.toUpperCase()] || LOG_LEVELS.DEBUG;
}

function log(level, message, data = null) {
  const logLevelNum = LOG_LEVELS[level.toUpperCase()] || LOG_LEVELS.INFO;
  if (logLevelNum < currentLogLevel) return;
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  if (data) {
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}

// Retry Logic with Exponential Backoff
class RetryableAPIClient {
  constructor(maxRetries = 3, baseDelay = 1000) {
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
  }

  async withRetry(operation, context = '') {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) break;
        
        // Don't retry on certain permanent errors
        if (error.response && [400, 401, 403, 404].includes(error.response.status)) {
          throw error;
        }
        
        const delay = this.baseDelay * Math.pow(2, attempt - 1);
        log('WARNING', `${context} attempt ${attempt} failed, retrying in ${delay}ms: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  static isRecoverableError(error) {
    const recoverablePatterns = [
      /network/i,
      /timeout/i,
      /connection/i,
      /temporary/i,
      /rate limit/i,
      /ECONNRESET/i,
      /ETIMEDOUT/i
    ];
    
    return recoverablePatterns.some(pattern => 
      pattern.test(error.message) || pattern.test(error.code || '')
    );
  }
}

// Progress Tracking
class ProgressTracker {
  constructor(total, logInterval = 10) {
    this.total = total;
    this.current = 0;
    this.logInterval = logInterval;
    this.startTime = Date.now();
  }

  update(current = null) {
    if (current !== null) this.current = current;
    else this.current++;

    if (this.current % this.logInterval === 0 || this.current === this.total) {
      const elapsed = (Date.now() - this.startTime) / 1000;
      const rate = this.current / elapsed;
      const eta = this.current < this.total ? (this.total - this.current) / rate : 0;
      
      log('INFO', `Progress: ${this.current}/${this.total} (${(this.current/this.total*100).toFixed(1)}%) - ${rate.toFixed(2)} rows/sec - ETA: ${eta.toFixed(0)}s`);
    }
  }
}

// Memory Management
class MemoryManager {
  static logMemoryUsage(context = '') {
    const used = process.memoryUsage();
    const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100;
    
    log('DEBUG', `Memory ${context}: RSS: ${mb(used.rss)}MB, Heap: ${mb(used.heapUsed)}MB/${mb(used.heapTotal)}MB, External: ${mb(used.external)}MB`);
    
    // Warn if memory usage is high
    if (used.heapUsed > 1024 * 1024 * 1024) { // 1GB
      log('WARNING', `High memory usage detected: ${mb(used.heapUsed)}MB heap used`);
    }
  }
  
  static forceGC() {
    if (global.gc) {
      global.gc();
      log('DEBUG', 'Forced garbage collection');
    }
  }
}

// Configuration Validation
class ConfigValidator {
  static validate(config) {
    const errors = [];
    
    if (!config.xlsxPath || !fs.existsSync(config.xlsxPath)) {
      errors.push(`XLSX file not found: ${config.xlsxPath}`);
    }
    
    if (config.maxRows && (config.maxRows < 1 || config.maxRows > 10000)) {
      errors.push(`maxRows must be between 1 and 10000, got: ${config.maxRows}`);
    }
    
    if (config.sleepBetween < 0 || config.sleepBetween > 60) {
      errors.push(`sleepBetween must be between 0 and 60 seconds, got: ${config.sleepBetween}`);
    }
    
    if (config.enformion) {
      if (!config.enformion.apName || !config.enformion.apPassword) {
        errors.push('Enformion credentials incomplete (missing apName or apPassword)');
      }
    }
    
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
    
    return true;
  }
}

// Data Validation and Cleanup
class DataValidator {
  static validateRowData(row, mapping, rowIndex) {
    const issues = [];
    
    // Check required fields
    const name = row[mapping.name];
    if (!name || normalizeSpace(name).length < 2) {
      issues.push(`Row ${rowIndex}: Name field is empty or too short`);
    }
    
    // Validate address components
    const city = row[mapping.city];
    const state = row[mapping.state];
    if (!city || !state) {
      issues.push(`Row ${rowIndex}: Missing city or state`);
    }
    
    // Check for suspicious data patterns
    const postal = row[mapping.postal];
    if (postal && !/^\d{5}(-\d{4})?$/.test(String(postal).trim())) {
      issues.push(`Row ${rowIndex}: Invalid postal code format: ${postal}`);
    }
    
    return issues;
  }

  static cleanAddress(address) {
    if (!address) return '';
    return normalizeSpace(address)
      .replace(/\b(SUITE|STE|UNIT|APT|APARTMENT)\b\s*#?/gi, 'STE ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static standardizeStateName(state) {
    const stateMap = {
      'CALIFORNIA': 'CA',
      'CALIF': 'CA',
      'CAL': 'CA'
    };
    return stateMap[String(state).toUpperCase()] || String(state).toUpperCase();
  }
}

// Utilities (enhanced)
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeSpace(s) {
  s = String(s ?? '');
  return s.trim().replace(/\s+/g, ' ');
}

// Enhanced person detection patterns
const nonPersonKeywords = /\b(LLC|L\.L\.C\.|INC|INCORPORATED|CORP|CORPORATION|LP|L\.P\.|LLP|L\.L\.P\.|TRUST|FAMILY\s+TRUST|HOLDINGS?|HOLDING|ENTERPRISES?|COMPANY|CO\.|FUND|PARTNERS?|PARTNERSHIP|ASSOCIATION|FOUNDATION|BANK|CHURCH|SCHOOL|UNIVERSITY|CITY|COUNTY|STATE|BOARD|DEPT|DEPARTMENT|GROUP|MANAGEMENT|INVESTMENTS?|VENTURES?|CAPITAL|PROPERTIES|REALTY|REAL\s+ESTATE|ESTATE)\b/i;

const personIndicators = /\b(MR|MRS|MS|DR|PROF|PROFESSOR|JR|SR|II|III|IV)\b/i;

function looksLikePerson(name) {
  if (!name) return false;
  name = normalizeSpace(name);
  
  // Strong indicators it's NOT a person
  if (nonPersonKeywords.test(name)) return false;
  
  // Strong indicators it IS a person
  if (personIndicators.test(name)) return true;
  
  // Check structure - person names typically have 2-4 parts
  const parts = name.split(' ').filter(p => p);
  if (parts.length < 2 || parts.length > 4) return false;
  
  // Check for typical person name patterns
  if (parts.length >= 2 && (name.match(/,/g) || []).length <= 1) {
    // All parts should look like name components (letters, apostrophes, hyphens, periods)
    const namePattern = /^[A-Za-z][A-Za-z\.\'-]*$/;
    return parts.every(part => namePattern.test(part));
  }
  
  return false;
}

function splitFirstLast(fullname) {
  const parts = normalizeSpace(fullname).replace(/,/g, ' ').split(/\s+/).filter(p => p);
  if (parts.length === 1) return [parts[0], ''];
  if (parts.length === 2) return [parts[0], parts[1]];
  // For 3+ parts, first is first name, last is last name
  return [parts[0], parts[parts.length - 1]];
}

function safeJson(val) {
  try {
    JSON.stringify(val);
    return val;
  } catch (e) {
    return String(val);
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function bestEffortDate(s) {
  try {
    return new Date(s);
  } catch (e) {
    return new Date(0); // min date
  }
}

function previewList(label, items, maxItems = 12) {
  const n = items.length;
  if (n <= maxItems) return `${label}=${JSON.stringify(items)}`;
  const head = items.slice(0, maxItems / 2);
  const tail = items.slice(-maxItems / 2);
  return `${label}=[${head.join(', ')}, ..., ${tail.join(', ')}] (total=${n})`;
}

// Enhanced similarity functions
function nameSimilarity(a, b) {
  a = normalizeSpace(a).toLowerCase();
  b = normalizeSpace(b).toLowerCase();
  if (!a || !b) return 0.0;
  if (a === b) return 1.0;
  
  // Tokenize and clean
  const at = new Set(a.match(/[a-z]+/g) || []);
  const bt = new Set(b.match(/[a-z]+/g) || []);
  if (at.size === 0 || bt.size === 0) return 0.0;
  
  // Jaccard similarity
  const intersection = new Set([...at].filter(x => bt.has(x)));
  const jaccard = intersection.size / (at.size + bt.size - intersection.size);
  
  // Bonus for exact first/last name matches
  const [aFirst, aLast] = splitFirstLast(a);
  const [bFirst, bLast] = splitFirstLast(b);
  let nameBonus = 0;
  if (aFirst && bFirst && aFirst.toLowerCase() === bFirst.toLowerCase()) nameBonus += 0.2;
  if (aLast && bLast && aLast.toLowerCase() === bLast.toLowerCase()) nameBonus += 0.3;
  
  return Math.min(1.0, jaccard + nameBonus);
}

function addressSimilarity(a, b) {
  a = normalizeSpace(a).toLowerCase();
  b = normalizeSpace(b).toLowerCase();
  if (!a || !b) return 0.0;
  
  function norm(x) {
    return x
      .replace(/\b(avenue|ave)\b/g, 'ave')
      .replace(/\b(street|st)\b/g, 'st')
      .replace(/\b(boulevard|blvd)\b/g, 'blvd')
      .replace(/\b(drive|dr)\b/g, 'dr')
      .replace(/\b(road|rd)\b/g, 'rd')
      .replace(/\b(suite|ste|unit|apt)\b/g, 'ste')
      .replace(/\b(north|n)\b/g, 'n')
      .replace(/\b(south|s)\b/g, 's')
      .replace(/\b(east|e)\b/g, 'e')
      .replace(/\b(west|w)\b/g, 'w')
      .replace(/[^a-z0-9 ]+/g, '');
  }
  
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1.0;
  
  const at = new Set(na.split(' ').filter(t => t));
  const bt = new Set(nb.split(' ').filter(t => t));
  if (at.size === 0 || bt.size === 0) return 0.0;
  
  const intersection = new Set([...at].filter(x => bt.has(x)));
  return intersection.size / (at.size + bt.size - intersection.size);
}

function confidenceScore(xlsxCtx, pdfName, pdfAddr, apiFirst, apiLast, apiAddr1, apiAddr2) {
  const xName = xlsxCtx.sourceName;
  const apiFull = normalizeSpace(`${apiFirst} ${apiLast}`);
  const pdfVsApi = nameSimilarity(pdfName, apiFull);
  const xlsxVsPdf = nameSimilarity(xName, pdfName);
  const xlsxVsApi = nameSimilarity(xName, apiFull);
  const xAddr = normalizeSpace(`${xlsxCtx.sourceAddress1} ${xlsxCtx.sourceCity} ${xlsxCtx.sourceState} ${xlsxCtx.sourcePostal}`);
  const apiAddr = normalizeSpace(`${apiAddr1} ${apiAddr2}`);
  const addrXVsPdf = addressSimilarity(xAddr, pdfAddr);
  const addrPdfVsApi = addressSimilarity(pdfAddr, apiAddr);
  
  // Enhanced bonuses
  const cityBonus = xlsxCtx.sourceCity && pdfAddr.toLowerCase().includes(xlsxCtx.sourceCity.toLowerCase()) ? 0.15 : 0.0;
  const stateBonus = xlsxCtx.sourceState && pdfAddr.toLowerCase().includes(xlsxCtx.sourceState.toLowerCase()) ? 0.1 : 0.0;
  const zipBonus = xlsxCtx.sourcePostal && pdfAddr.includes(xlsxCtx.sourcePostal) ? 0.1 : 0.0;
  
  const score = (
    0.25 * pdfVsApi +
    0.20 * xlsxVsPdf +
    0.15 * xlsxVsApi +
    0.15 * addrXVsPdf +
    0.10 * addrPdfVsApi +
    cityBonus +
    stateBonus +
    zipBonus
  );
  
  log('DEBUG', `Confidence components: pdf_vs_api=${pdfVsApi.toFixed(3)} xlsx_vs_pdf=${xlsxVsPdf.toFixed(3)} xlsx_vs_api=${xlsxVsApi.toFixed(3)} addr_x_vs_pdf=${addrXVsPdf.toFixed(3)} addr_pdf_vs_api=${addrPdfVsApi.toFixed(3)} city_bonus=${cityBonus.toFixed(2)} state_bonus=${stateBonus.toFixed(2)} zip_bonus=${zipBonus.toFixed(2)} -> score=${score.toFixed(3)}`);
  return Math.max(0.0, Math.min(1.0, score));
}

// Enhanced PDF Parsing
class EnhancedPDFParser {
  static async extractTextWithFallbacks(pdfBuffer) {
    const strategies = [
      // Primary strategy
      async () => {
        if (!pdfParse) throw new Error('pdf-parse not available');
        const data = await pdfParse(pdfBuffer);
        return data.text || '';
      },
      
      // Fallback: Try with different options
      async () => {
        if (!pdfParse) throw new Error('pdf-parse not available');
        const data = await pdfParse(pdfBuffer, {
          version: '1.10.100',
          max: 0, // no limit
          normalizeWhitespace: true
        });
        return data.text || '';
      }
    ];

    for (const [index, strategy] of strategies.entries()) {
      try {
        const result = await strategy();
        if (result && result.length > 50) { // Minimum viable content
          log('DEBUG', `PDF extraction succeeded with strategy ${index + 1}`);
          return result;
        }
      } catch (error) {
        log('WARNING', `PDF extraction strategy ${index + 1} failed: ${error.message}`);
      }
    }
    
    log('ERROR', 'All PDF extraction strategies failed');
    return '';
  }

  static async parseManagersFromPdfText(text) {
    if (!text) return [];
    
    text = text.replace(/\r/g, '\n');
    log('DEBUG', `PDF text preview (first 500 chars): ${text.substring(0, 500)}`);
    
    // Find the Manager/Member section
    let startIdx = -1;
    const markers = [
      'Manager(s) or Member(s)',
      'Managers or Members', 
      'Manager or Member Name',
      'Manager(s) or Member(s)\n',
    ];
    
    for (const marker of markers) {
      startIdx = text.indexOf(marker);
      if (startIdx !== -1) {
        log('DEBUG', `Found section marker: "${marker}" at position ${startIdx}`);
        break;
      }
    }
    
    if (startIdx === -1) {
      log('WARNING', 'No Manager/Member section markers found in PDF');
      return [];
    }
    
    // Find section end
    let endPos = text.length;
    const endMarkers = [
      '\nAgent for Service of Process',
      '\nAgent Name',
      '\nType of Business',
      '\nEmail Notifications',
      '\nChief Executive Officer',
      '\nLabor Judgment',
      '\nLabor Judgement',
      '\nSTATE OF CALIFORNIA',
    ];
    
    for (const endMarker of endMarkers) {
      const j = text.indexOf(endMarker, startIdx);
      if (j !== -1) endPos = Math.min(endPos, j);
    }
    
    let block = text.substring(startIdx, endPos);
    log('DEBUG', `Extracted manager block (${block.length} chars): ${block.substring(0, 300)}`);
    
    let lines = block.split('\n').map(normalizeSpace).filter(l => l);
    
    // Enhanced header pattern removal
    const headerPatterns = [
      /^Manager\(s\)\s*or\s*Member\(s\)$/i,
      /^Managers?\s*or\s*Members?$/i,
      /^Manager\s*or\s*Member\s*Name$/i,
      /^Manager\s*or\s*Member\s*Address$/i,
      /^Manager\s*or\s*Member\s*Name\s*Manager\s*or\s*Member\s*Address$/i,
      /^Name\s*Address$/i,
      /^\+?\s*$/,  // Just a plus sign or empty
    ];
    
    lines = lines.filter(l => !headerPatterns.some(p => p.test(l)));
    log('DEBUG', `After header removal, ${lines.length} lines: ${JSON.stringify(lines.slice(0, 10))}`);
    
    const results = [];
    let i = 0;
    
    while (i < lines.length) {
      let line = lines[i];
      
      // Remove leading + symbol
      line = line.replace(/^\+\s*/, '');
      if (!line) {
        i++;
        continue;
      }
      
      // Handle inline name+address (e.g., "JOHN SMITH123 MAIN ST")
      let namePart = null;
      let addrSeed = null;
      
      // Look for pattern where address starts with a digit
      const inlineMatch = line.match(/^(.+?)\s*(\d[^\s].*)$/);
      if (inlineMatch) {
        namePart = normalizeSpace(inlineMatch[1]);
        addrSeed = normalizeSpace(inlineMatch[2]);
        log('DEBUG', `Detected inline format: name="${namePart}" addr_seed="${addrSeed}"`);
      }
      
      const candidateName = namePart || line;
      
      // Enhanced person detection
      if (this.isLikelyPersonName(candidateName)) {
        const addrLines = [];
        if (addrSeed) addrLines.push(addrSeed);
        
        let j = i + 1;
        // Limit address collection to prevent runaway concatenation
        let addressLinesCollected = 0;
        const maxAddressLines = 3;
        
        while (j < lines.length && addressLinesCollected < maxAddressLines) {
          const nextLine = lines[j].replace(/^\+\s*/, '');
          
          // Stop if next line looks like a new person or header
          if (this.isLikelyPersonName(nextLine)) break;
          if (headerPatterns.some(p => p.test(nextLine))) break;
          
          // Stop if line looks like form artifacts
          if (this.isFormArtifact(nextLine)) break;
          
          addrLines.push(nextLine);
          addressLinesCollected++;
          j++;
        }
        
        const name = candidateName;
        const addr = DataValidator.cleanAddress(addrLines.join(' ').trim());
        
        if (this.isValidManagerEntry(name, addr)) {
          results.push([normalizeSpace(name), normalizeSpace(addr)]);
          log('DEBUG', `Added manager: "${name}" -> "${addr}"`);
        }
        
        i = j;
      } else {
        log('DEBUG', `Skipping non-person line: "${candidateName}"`);
        i++;
      }
    }
    
    // Dedup and rank by quality
    const deduped = this.deduplicateAndRank(results);
    log('INFO', `Extracted ${deduped.length} unique managers from PDF`);
    
    return deduped;
  }
  
  static isLikelyPersonName(name) {
    if (!name) return false;
    name = normalizeSpace(name);
    
    // Skip obvious non-person entries
    if (nonPersonKeywords.test(name)) return false;
    if (/^(Manager|Member|Name|Address)/i.test(name)) return false;
    
    // Skip form artifacts and common PDF extraction errors
    if (this.isFormArtifact(name)) return false;
    
    // Must look like a person name
    return looksLikePerson(name);
  }
  
  static isFormArtifact(text) {
    if (!text) return false;
    const formArtifacts = [
      /^(Type|Print|Name|Title|Signature|Date|Page|LLC|REV|Secretary|State|bizfile)/i,
      /^\d+\/\d+\/\d+/,  // Dates
      /^(CA|California|North Hollywood|Los Angeles|Burbank|Glendale)\s+CA\s+\d{5}/i,  // City CA ZIP only
      /^(Street Address|City|State|Zip|Code)/i,
      /^(Yes|No)\s+(By signing|I affirm|under penalty)/i,
      /^(Complete|Item|Do not|Must provide)/i,
      /^[A-Z\s]{20,}/,  // Long all-caps strings (likely headers)
      /penalty\s+of\s+perjury/i,
      /California\s+law\s+to\s+sign/i,
      /^\d+\.\s*By\s+signing/i,  // Numbered form instructions
      /P\.O\.\s+Box/i,
      /electronic\s+signature/i
    ];
    
    return formArtifacts.some(pattern => pattern.test(text));
  }
  
  static isValidManagerEntry(name, addr) {
    // Name must be person-like
    if (!looksLikePerson(name)) return false;
    
    // Skip entries that are obviously headers or artifacts
    if (/^(Manager|Member|Name|Address)/i.test(name)) return false;
    
    // Skip form artifacts
    if (this.isFormArtifact(name)) return false;
    
    // Name should be reasonable length (not too long, suggesting concatenation errors)
    if (name.length > 50) return false;
    
    // Should have at least 2 name parts
    const nameParts = name.split(/\s+/).filter(p => p);
    if (nameParts.length < 2) return false;
    
    // Address should have some content (but not required)
    return true;
  }
  
  static deduplicateAndRank(results) {
    const dedup = new Map();
    
    for (const [name, addr] of results) {
      const key = normalizeSpace(name).toLowerCase();
      const existing = dedup.get(key);
      
      if (!existing || addr.length > existing[1].length) {
        // Keep the entry with the longer address
        dedup.set(key, [name, addr]);
      }
    }
    
    // Return sorted by name length (shorter names often more accurate)
    return Array.from(dedup.values()).sort((a, b) => a[0].length - b[0].length);
  }
}

// Enhanced XLSX Field Detection
function detectFields(headers) {
  const cols = headers.reduce((acc, c) => { acc[c] = (c || '').toLowerCase(); return acc; }, {});
  
  function pick(...keys) {
    // Score each column against each key
    let bestMatch = null;
    let bestScore = 0;
    
    for (const k of keys) {
      for (const [c, lc] of Object.entries(cols)) {
        let score = 0;
        if (lc === k) score = 100; // exact match
        else if (lc.includes(k)) score = 50; // contains
        else if (k.includes(lc) && lc.length > 2) score = 25; // key contains column
        
        if (score > bestScore) {
          bestScore = score;
          bestMatch = c;
        }
      }
    }
    
    return bestMatch;
  }
  
  const mapping = {
    name: pick('owner', 'name', 'entity', 'company', 'business', 'llc'),
    address1: pick('address1', 'addr1', 'street', 'address'),
    address2: pick('address2', 'addr2', 'suite', 'ste', 'unit', 'apt'),
    city: pick('city'),
    state: pick('state', 'st'),
    postal: pick('zip', 'postal', 'zipcode', 'zip_code'),
  };
  
  log('DEBUG', 'Field detection mapping:', mapping);
  return mapping;
}

function makeRowContext(i, row, mapping) {
  function g(k) {
    const c = mapping[k];
    const val = c ? row[c] : '';
    return normalizeSpace(val);
  }
  
  const srcName = g('name');
  const entityGuess = /\b(LLC|INC|CORP|LP|LLP|CO\.|COMPANY|HOLDINGS?)\b/i.test(srcName) ? srcName : '';
  
  return {
    rowIndex: i,
    sourceName: srcName,
    sourceEntity: entityGuess,
    sourceAddress1: g('address1'),
    sourceAddress2: g('address2'),
    sourceCity: g('city'),
    sourceState: DataValidator.standardizeStateName(g('state')),
    sourcePostal: g('postal'),
  };
}

// HTML Template (enhanced)
const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Enrich Log Viewer</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Helvetica,Arial,sans-serif;margin:16px;background:#f8f9fa;}
h1{font-size:24px;margin:0 0 16px;color:#333;}
.controls{display:flex;gap:12px;align-items:center;margin:16px 0;padding:12px;background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);}
input[type="search"]{padding:8px 12px;flex:1;border:1px solid #ddd;border-radius:6px;font-size:14px;}
.stats{display:flex;gap:16px;}
.badge{display:inline-block;padding:4px 8px;border-radius:6px;border:1px solid #ddd;background:#f8f8f8;font-size:12px;font-weight:600;}
table{border-collapse:collapse;width:100%;background:white;border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,0.1);}
th,td{border-bottom:1px solid #eee;padding:12px 8px;vertical-align:top;font-size:12px;}
th{position:sticky;top:0;background:#f8f9fa;font-weight:600;color:#555;}
.code{white-space:pre-wrap;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;font-size:11px;}
small{color:#666;font-size:11px;}
.confidence{font-weight:bold;}
.confidence.high{color:#28a745;}
.confidence.medium{color:#ffc107;}
.confidence.low{color:#dc3545;}
.status-200{background:#d4edda;color:#155724;}
.status-404{background:#f8d7da;color:#721c24;}
.status-error{background:#f8d7da;color:#721c24;}
tr:hover{background:#f8f9fa;}
</style>
</head>
<body>
<h1>Enrich Log Viewer</h1>
<div class="controls">
  <input id="q" type="search" placeholder="Search any field..."/>
  <div class="stats">
    <span class="badge">Showing: <span id="count">0</span></span>
    <span class="badge">Total: <span id="total">0</span></span>
    <span class="badge">Avg Confidence: <span id="avgConf">0.000</span></span>
  </div>
</div>
<table id="tbl">
  <thead><tr>
    <th>Time</th>
    <th>Row</th>
    <th>Query</th>
    <th>PDF Managers</th>
    <th>Chosen</th>
    <th>API Status</th>
    <th>API Person</th>
    <th>Confidence</th>
    <th>Raw</th>
  </tr></thead>
  <tbody></tbody>
</table>
<script>
const Q = document.getElementById('q');
const T = document.querySelector('#tbl tbody');
const COUNT = document.getElementById('count');
const TOTAL = document.getElementById('total');
const AVG_CONF = document.getElementById('avgConf');
let DATA = [];

fetch('./{logJson}')
 .then(r=>r.json())
 .then(j => { DATA = j; TOTAL.textContent = DATA.length; render(); });

function render() {
  const q = (Q.value||'').toLowerCase();
  T.innerHTML = '';
  let n=0, confSum=0;
  
  for(const r of DATA){
    const blob = JSON.stringify(r).toLowerCase();
    if(q && !blob.includes(q)) continue;
    n++;
    confSum += (r.confidence || 0);
    
    const tr = document.createElement('tr');
    const td = (v) => { const e=document.createElement('td'); e.innerHTML=v; return e; }
    
    tr.appendChild(td(\`<small>\${r.time}</small>\`));
    tr.appendChild(td(\`\${r.row_index}\`));
    tr.appendChild(td(\`<div><strong>\${escapeHtml(r.query||'')}</strong></div><small class="code">\${escapeHtml(JSON.stringify(r.xlsx_ctx||'',null,0))}</small>\`));
    tr.appendChild(td((r.pdf_managers||[]).map(x=>\`<div><strong>\${escapeHtml(x[0])}</strong><br/><small>\${escapeHtml(x[1])}</small></div>\`).join('')));
    tr.appendChild(td(\`<strong>\${escapeHtml(r.chosen_name||'')}</strong>\`));
    
    const status = r.api_status || '';
    const statusClass = status == 200 ? 'status-200' : (status == 404 ? 'status-404' : (status ? 'status-error' : ''));
    tr.appendChild(td(\`<span class="badge \${statusClass}">\${status}</span>\`));
    
    tr.appendChild(td(\`\${escapeHtml(r.api_person||'')}\`));
    
    const conf = r.confidence || 0;
    const confClass = conf > 0.7 ? 'high' : (conf > 0.4 ? 'medium' : 'low');
    tr.appendChild(td(\`<span class="confidence \${confClass}">\${conf.toFixed(3)}</span>\`));
    
    tr.appendChild(td(\`<details><summary>view</summary><div class="code">\${escapeHtml(JSON.stringify(r.api_raw,null,2))}</div></details>\`));
    T.appendChild(tr);
  }
  
  COUNT.textContent = n;
  AVG_CONF.textContent = n > 0 ? (confSum / n).toFixed(3) : '0.000';
}

Q.addEventListener('input', render);

function escapeHtml(s){
  return (s||'').toString()
     .replace(/&/g,'&amp;')
     .replace(/</g,'&lt;')
     .replace(/>/g,'&gt;');
}
</script>
</body>
</html>`;

// CASOSService (enhanced with retry logic)
class CASOSService {
  constructor() {
    this.baseUrl = 'https://bizfileonline.sos.ca.gov';
    this.siteId = '2299457';
    this.cookies = {};
    this.browser = null;
    this.context = null;
    this.page = null;
    this.retryClient = new RetryableAPIClient(3, 1000);
  }

  async initialize() {
    log('INFO', 'Initializing browser...');
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
      
      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });
      
      this.page = await this.context.newPage();
      
      log('INFO', 'Navigating to search page...');
      await this.page.goto(`${this.baseUrl}/search/business`, {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      
      await this.page.waitForTimeout(3000);
      
      await this.page.waitForFunction(
        () => document.cookie.includes('reese84'),
        { timeout: 15000 }
      ).catch(() => log('WARN', 'reese84 cookie not detected'));
      
      const cookies = await this.context.cookies();
      log('INFO', `Captured ${cookies.length} cookies`);
      
      cookies.forEach(cookie => {
        this.cookies[cookie.name] = cookie.value;
      });
      
      await this.page.waitForTimeout(2000);
      log('INFO', 'Initialization complete');
      return true;
      
    } catch (error) {
      log('ERROR', `Initialization failed: ${error.message}`);
      throw error;
    }
  }

  getCookieString() {
    return Object.entries(this.cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async search(searchTerm) {
    log('INFO', `Searching for: "${searchTerm}"`);
    
    const searchPayload = {
      "SEARCH_VALUE": searchTerm,
      "SEARCH_FILTER_TYPE_ID": "0",
      "SEARCH_TYPE_ID": "1",
      "FILING_TYPE_ID": "",
      "STATUS_ID": "",
      "FILING_DATE": {"start": null, "end": null},
      "CORPORATION_BANKRUPTCY_YN": false,
      "CORPORATION_LEGAL_PROCEEDINGS_YN": false,
      "OFFICER_OBJECT": {"FIRST_NAME": "", "MIDDLE_NAME": "", "LAST_NAME": ""},
      "NUMBER_OF_FEMALE_DIRECTORS": "99",
      "NUMBER_OF_UNDERREPRESENTED_DIRECTORS": "99",
      "COMPENSATION_FROM": "",
      "COMPENSATION_TO": "",
      "SHARES_YN": false,
      "OPTIONS_YN": false,
      "BANKRUPTCY_YN": false,
      "FRAUD_YN": false,
      "LOANS_YN": false,
      "AUDITOR_NAME": ""
    };

    const operation = async () => {
      const response = await axios.post(`${this.baseUrl}/api/Records/businesssearch`, searchPayload, {
        headers: {
          'accept': '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'authorization': 'undefined',
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          'cookie': this.getCookieString(),
          'origin': this.baseUrl,
          'pragma': 'no-cache',
          'referer': `${this.baseUrl}/search/business`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        },
        timeout: 30000
      });
      
      const data = response.data;
      const results = [];
      
      if (data.rows) {
        for (const [entityId, row] of Object.entries(data.rows)) {
          let businessName = '';
          let entityNumber = '';
          
          if (row.TITLE && row.TITLE[0]) {
            const titleText = row.TITLE[0];
            const nameMatch = titleText.match(/^(.+?)\s*\(/);
            businessName = nameMatch ? nameMatch[1].trim() : titleText;
            const entityMatch = titleText.match(/\((\d+)\)/);
            entityNumber = entityMatch ? entityMatch[1] : '';
          }
          
          results.push({
            businessName,
            entityNumber,
            entityId: row.ID || entityId,
            filingDate: row.FILING_DATE,
            status: row.STATUS,
            entityType: row.ENTITY_TYPE,
            formedIn: row.FORMED_IN,
            agent: row.AGENT,
            standing: row.STANDING,
            recordNum: row.RECORD_NUM,
            canFileAR: row.CAN_FILE_AR,
            alert: row.ALERT,
            sortIndex: row.SORT_INDEX
          });
        }
      }
      
      log('INFO', `Found ${results.length} results`);
      return results;
    };

    return await this.retryClient.withRetry(operation, `Search for "${searchTerm}"`);
  }

  async getBusinessDetails(entityId) {
    log('INFO', `Getting details for entity: ${entityId}`);
    
    const operation = async () => {
      const response = await axios.get(`${this.baseUrl}/api/FilingDetail/business/${entityId}/false`, {
        headers: {
          'accept': '*/*',
          'authorization': 'undefined',
          'cookie': this.getCookieString(),
          'referer': `${this.baseUrl}/search/business`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        },
        timeout: 30000
      });
      
      const filingData = response.data;
      const details = {
        entityId,
        drawerDetails: {}
      };
      
      if (filingData.DRAWER_DETAIL_LIST) {
        for (const item of filingData.DRAWER_DETAIL_LIST) {
          details.drawerDetails[item.LABEL] = {
            value: item.VALUE,
            alert: item.ALERT_YN
          };
        }
      }
      
      return details;
    };

    return await this.retryClient.withRetry(operation, `Get details for entity ${entityId}`);
  }

  async getBusinessHistory(recordNum) {
    log('INFO', `Getting history for record: ${recordNum}`);
    
    const operation = async () => {
      const response = await axios.get(`${this.baseUrl}/api/History/business/${recordNum}`, {
        headers: {
          'accept': '*/*',
          'authorization': 'undefined',
          'cookie': this.getCookieString(),
          'referer': `${this.baseUrl}/search/business`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        },
        timeout: 30000
      });
      
      const historyData = response.data;
      const filings = [];
      
      if (historyData.AMENDMENT_LIST) {
        for (const amendment of historyData.AMENDMENT_LIST) {
          if (amendment.DOWNLOAD_LINK) {
            filings.push({
              type: amendment.AMENDMENT_TYPE,
              controlId: amendment.AMENDMENT_NUM,
              date: amendment.AMENDMENT_DATE,
              downloadLink: amendment.DOWNLOAD_LINK,
              fullUrl: `${this.baseUrl}${amendment.DOWNLOAD_LINK}`
            });
          }
        }
      }
      
      log('INFO', `Found ${filings.length} filing documents`);
      return {
        filings,
        history: historyData.HISTORY_LIST || []
      };
    };

    return await this.retryClient.withRetry(operation, `Get history for record ${recordNum}`);
  }

  async downloadPDF(downloadUrl) {
    log('INFO', `Downloading PDF from: ${downloadUrl}`);
    
    const operation = async () => {
      const response = await axios.get(downloadUrl, {
        headers: {
          'accept': '*/*',
          'cookie': this.getCookieString(),
          'referer': `${this.baseUrl}/search/business`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        },
        responseType: 'arraybuffer',
        timeout: 60000  // Longer timeout for downloads
      });
      
      return Buffer.from(response.data);
    };

    return await this.retryClient.withRetry(operation, `Download PDF ${downloadUrl}`);
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// Enhanced Enformion Client
class EnformionClient {
  constructor(config) {
    this.config = config;
    this.retryClient = new RetryableAPIClient(2, 2000); // Fewer retries for API calls
  }

  async contactEnrich(first, last, line1 = '', line2 = '', phone = '', email = '') {
    const body = {
      FirstName: first || '',
      MiddleName: '',
      LastName: last || '',
      Dob: '',
      Age: 0,
      Address: {
        addressLine1: line1 || '',
        addressLine2: line2 || '',
      },
      Phone: phone || '',
      Email: email || '',
    };
    
    log('DEBUG', `Enformion POST ${this.config.apiUrl}`, body);
    
    const operation = async () => {
      const response = await axios.post(this.config.apiUrl, body, {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'galaxy-ap-name': this.config.apName,
          'galaxy-ap-password': this.config.apPassword,
          'galaxy-client-type': this.config.clientType,
          'galaxy-search-type': this.config.searchType,
        },
        timeout: this.config.timeout * 1000,
      });
      
      const status = response.status;
      const data = response.data;
      log('DEBUG', `Enformion status=${status}`);
      return [status, data];
    };

    try {
      return await this.retryClient.withRetry(operation, `Enformion enrich ${first} ${last}`);
    } catch (error) {
      const status = error.response ? error.response.status : 0;
      const data = error.response ? (error.response.data || { raw: error.message }) : { raw: error.message };
      log('DEBUG', `Enformion status=${status} (error)`);
      return [status, data];
    }
  }
}

// Enhanced Pipeline
class BizfileEnricher {
  constructor(config) {
    this.config = config;
    this.service = new CASOSService();
    this.enformion = config.enformion ? new EnformionClient(config.enformion) : null;
    this.logPath = path.join(config.outDir, 'enrich_log.json');
    this.csvPath = path.join(config.outDir, 'augmented.csv');
    this.htmlPath = path.join(config.outDir, 'index.html');
    this.logData = [];
    
    if (fs.existsSync(this.logPath)) {
      try {
        this.logData = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
      } catch (e) {
        log('WARNING', `Failed to load existing log: ${e.message}`);
      }
    }
  }

  appendLog(entry) {
    this.logData.push(entry);
    fs.writeFileSync(this.logPath, JSON.stringify(this.logData, null, 2), 'utf8');
  }

  writeHtmlViewer() {
    const html = HTML_TEMPLATE.replace('{logJson}', 'enrich_log.json');
    fs.writeFileSync(this.htmlPath, html, 'utf8');
  }

  async run() {
    await ensureDir(this.config.outDir);
    MemoryManager.logMemoryUsage('startup');
    
    await this.service.initialize();

    log('INFO', `Loading XLSX: ${this.config.xlsxPath}`);
    const workbook = XLSX.readFile(this.config.xlsxPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const df = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const headers = df[0];
    const rows = df.slice(1);
    
    log('INFO', `DataFrame loaded: shape=(${rows.length}, ${headers.length}) columns=${headers}`);

    if (rows.length === 0) {
      log('WARNING', 'No rows found in XLSX. Exiting.');
      return;
    }

    const mapping = detectFields(headers);
    log('INFO', `Detected field mapping:`, mapping);

    // Validate rows
    let validationIssues = 0;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const row = {};
      headers.forEach((h, idx) => { row[h] = rows[i][idx]; });
      const issues = DataValidator.validateRowData(row, mapping, i + 1);
      if (issues.length > 0) {
        issues.forEach(issue => log('WARNING', issue));
        validationIssues++;
      }
    }
    
    if (validationIssues > 0) {
      log('INFO', `Found ${validationIssues} validation issues in sample rows`);
    }

    // Reverse rows (bottom to top)
    const revRows = rows.slice().reverse();
    let maxRows = this.config.maxRows;
    if (maxRows) {
      revRows.splice(maxRows);
      log('INFO', `Applying max_rows=${maxRows} -> truncated shape=(${revRows.length}, ${headers.length})`);
    }

    // Original indices
    const originalIndices = Array.from({ length: rows.length }, (_, i) => rows.length - i).slice(0, revRows.length);
    log('INFO', previewList('Processing order (bottom->top original 1-based indices)', originalIndices));

    const outCols = [...headers, 
      'DetectedManagers',
      'ChosenManager',
      'ChosenManagerAddress',
      'APIStatus',
      'APIFirstName',
      'APILastName',
      'APIAddress1',
      'APIAddress2',
      'ConfidenceScore',
      'BizfileRecordNum',
      'BizfileSourceId',
      'PDFFileSaved'
    ];

    log('INFO', `Writing augmented CSV to ${this.csvPath}`);
    const csvStream = fs.createWriteStream(this.csvPath, { encoding: 'utf8' });
    
    // Enhanced CSV header with BOM for Excel compatibility
    csvStream.write('\ufeff'); // BOM
    csvStream.write(outCols.map(col => `"${col}"`).join(',') + '\n');

    const progress = new ProgressTracker(revRows.length, 5);

    for (let i = 0; i < revRows.length; i++) {
      const row = {};
      headers.forEach((h, idx) => { row[h] = revRows[i][idx]; });
      const origRowIndex = originalIndices[i];
      const ctx = makeRowContext(origRowIndex, row, mapping);
      
      // Skip empty rows early
      if (!ctx.sourceName && !ctx.sourceAddress1 && !ctx.sourceCity) {
        log('DEBUG', `Row ${origRowIndex}: Empty row, skipping`);
        
        // Still write empty row to CSV to maintain row correspondence
        const emptyRowOut = headers.map(() => '').concat([
          '', '', '', '', '', '', '', '', '0.000', '', '', ''
        ]);
        const csvLine = emptyRowOut.map(v => {
          const str = String(v ?? '');
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        }).join(',') + '\n';
        csvStream.write(csvLine);
        
        // Add empty log entry
        const emptyLogEntry = {
          time: nowIso(),
          row_index: origRowIndex,
          query: '',
          xlsx_ctx: {
            name: '',
            address1: '',
            address2: '',
            city: '',
            state: '',
            postal: '',
          },
          pdf_managers: [],
          chosen_name: '',
          chosen_addr: '',
          api_status: null,
          api_person: '',
          confidence: 0,
          bizfile_record_num: '',
          bizfile_source_id: '',
          api_raw: {},
          pdf_saved: '',
        };
        this.appendLog(emptyLogEntry);
        
        progress.update();
        continue;
      }
      
      log('INFO', `Row ${origRowIndex} preprocess -> name='${ctx.sourceName}' entity_guess='${ctx.sourceEntity}' addr1='${ctx.sourceAddress1}' addr2='${ctx.sourceAddress2}' city='${ctx.sourceCity}' state='${ctx.sourceState}' zip='${ctx.sourcePostal}'`);

      let query = ctx.sourceEntity || ctx.sourceName;
      let pdfManagers = [];
      let pdfSaved = '';
      let sourceId = null;
      let recordNum = null;
      let apiStatus = null;
      let apiFirst = '';
      let apiLast = '';
      let apiAddr1 = '';
      let apiAddr2 = '';
      let chosenName = '';
      let chosenAddr = '';
      let conf = 0.0;
      let apiRaw = {};

      if (!query) {
        log('WARNING', `Row ${origRowIndex}: No queryable name/entity. Skipping biz search.`);
      } else {
        try {
          log('INFO', `Row ${origRowIndex}: Bizfile search query='${query}'`);
          const searchResults = await this.service.search(query);
          log('DEBUG', `Row ${origRowIndex}: Bizfile returned ${searchResults.length} candidates`);
          
          let best = null;
          let bestSortIndex = Infinity;
          searchResults.forEach(res => {
            const sortIndex = parseInt(res.sortIndex ?? '1000000000', 10);
            if (sortIndex < bestSortIndex) {
              best = res;
              bestSortIndex = sortIndex;
            }
          });
          
          if (best) {
            sourceId = best.entityId;
            recordNum = best.recordNum;
            log('INFO', `Row ${origRowIndex}: Chosen candidate -> ID=${sourceId} RECORD_NUM=${recordNum} TITLE=${best.businessName} SORT_INDEX=${bestSortIndex}`);
          } else {
            log('INFO', `Row ${origRowIndex}: No Bizfile candidates selected`);
          }
        } catch (e) {
          log('ERROR', `Row ${origRowIndex}: Bizfile search failed: ${e.message}`);
        }
      }

      if (sourceId && recordNum) {
        try {
          await this.service.getBusinessDetails(sourceId);
          const historyData = await this.service.getBusinessHistory(recordNum);
          const amends = historyData.filings;
          log('INFO', `Row ${origRowIndex}: Found ${amends.length} amendments`);
          
          let soi = amends.filter(a => (a.type ?? '').toLowerCase().includes('statement of information'));
          if (soi.length > 0) {
            soi.sort((a, b) => bestEffortDate(b.date) - bestEffortDate(a.date));
            log('INFO', `Row ${origRowIndex}: SOI list sorted desc by date:`, soi.map(a => ({num: a.controlId, date: a.date})));
            
            const dl = soi[0].fullUrl;
            if (dl) {
              log('INFO', `Row ${origRowIndex}: Downloading SOI PDF: ${dl}`);
              const pdfBuffer = await this.service.downloadPDF(dl);
              const pdfName = `bizfile_${sourceId}_${Date.now()}.pdf`;
              pdfSaved = pdfName;
              const pdfPath = path.join(this.config.outDir, pdfName);
              await fsp.writeFile(pdfPath, pdfBuffer);
              
              const text = await EnhancedPDFParser.extractTextWithFallbacks(pdfBuffer);
              log('DEBUG', `Row ${origRowIndex}: PDF text length=${text.length}`);
              pdfManagers = await EnhancedPDFParser.parseManagersFromPdfText(text);
              log('INFO', `Row ${origRowIndex}: Parsed managers:`, pdfManagers);
            }
          } else {
            log('INFO', `Row ${origRowIndex}: No Statement of Information amendments found`);
          }
        } catch (e) {
          log('ERROR', `Row ${origRowIndex}: Filing detail/history/PDF parse failed: ${e.message}`);
        }
      }

      // Select best manager (person-like, with address preference)
      for (const [name, addr] of pdfManagers) {
        if (looksLikePerson(name)) {
          // Prefer entries with addresses, especially those matching source city
          const hasAddr = addr && addr.length > 10;
          const cityMatch = ctx.sourceCity && addr.toLowerCase().includes(ctx.sourceCity.toLowerCase());
          
          if (!chosenName || hasAddr || cityMatch) {
            chosenName = name;
            chosenAddr = addr;
            if (cityMatch) break; // Stop on city match
          }
        }
      }
      
      if (chosenName) {
        log('INFO', `Row ${origRowIndex}: Chosen manager='${chosenName}' addr='${chosenAddr}'`);
      } else {
        log('INFO', `Row ${origRowIndex}: No person-like manager found to query Enformion`);
      }

      if (this.enformion && chosenName) {
        const [f, l] = splitFirstLast(chosenName);
        log('INFO', `Row ${origRowIndex}: Enformion query first='${f}' last='${l}' addr_line1='${chosenAddr}'`);
        
        [apiStatus, apiRaw] = await this.enformion.contactEnrich(f, l, chosenAddr);
        if (typeof apiRaw === 'object' && apiRaw !== null) {
          apiFirst = apiRaw.FirstName ?? apiRaw.firstName ?? '';
          apiLast = apiRaw.LastName ?? apiRaw.lastName ?? '';
          const addrObj = apiRaw.Address ?? apiRaw.address ?? {};
          apiAddr1 = addrObj.addressLine1 ?? '';
          apiAddr2 = addrObj.addressLine2 ?? '';
          log('INFO', `Row ${origRowIndex}: Enformion status=${apiStatus} person='${apiFirst} ${apiLast}' addr1='${apiAddr1}' addr2='${apiAddr2}'`);
        }
      }

      conf = confidenceScore(
        ctx,
        chosenName || '',
        chosenAddr || '',
        apiFirst || '',
        apiLast || '',
        apiAddr1 || '',
        apiAddr2 || ''
      );
      
      log('INFO', `Row ${origRowIndex}: Confidence=${conf.toFixed(3)}`);

      const logEntry = {
        time: nowIso(),
        row_index: origRowIndex,
        query: query,
        xlsx_ctx: {
          name: ctx.sourceName,
          address1: ctx.sourceAddress1,
          address2: ctx.sourceAddress2,
          city: ctx.sourceCity,
          state: ctx.sourceState,
          postal: ctx.sourcePostal,
        },
        pdf_managers: pdfManagers,
        chosen_name: chosenName,
        chosen_addr: chosenAddr,
        api_status: apiStatus,
        api_person: normalizeSpace(`${apiFirst} ${apiLast}`) || '',
        confidence: conf,
        bizfile_record_num: recordNum || '',
        bizfile_source_id: sourceId || '',
        api_raw: safeJson(apiRaw),
        pdf_saved: pdfSaved,
      };
      
      this.appendLog(logEntry);

      // Enhanced CSV output with proper escaping
      const rowOut = headers.map(h => row[h] ?? '').concat([
        pdfManagers.map(([n, a]) => `${n} | ${a}`).join('; ') || '',
        chosenName,
        chosenAddr,
        apiStatus ?? '',
        apiFirst,
        apiLast,
        apiAddr1,
        apiAddr2,
        conf.toFixed(3),
        recordNum || '',
        sourceId || '',
        pdfSaved,
      ]);
      
      const csvLine = rowOut.map(v => {
        const str = String(v ?? '');
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(',') + '\n';
      
      csvStream.write(csvLine);
      progress.update();

      // Memory management
      if (i % 50 === 0) {
        MemoryManager.logMemoryUsage(`after row ${origRowIndex}`);
        if (i % 100 === 0) {
          MemoryManager.forceGC();
        }
      }

      await new Promise(resolve => setTimeout(resolve, this.config.sleepBetween * 1000));
    }

    csvStream.end();
    this.writeHtmlViewer();
    
    MemoryManager.logMemoryUsage('completion');
    log('INFO', `Done. CSV: ${this.csvPath} | Log: ${this.logPath} | HTML viewer: ${this.htmlPath}`);
    
    await this.service.cleanup();
  }
}

// Main
(async () => {
  const argv = yargs(hideBin(process.argv))
    .option('xlsx', { type: 'string', demandOption: true, describe: 'Path to input XLSX' })
    .option('out', { type: 'string', default: 'out', describe: 'Output directory' })
    .option('ap-name', { type: 'string', describe: 'Enformion galaxy-ap-name' })
    .option('ap-password', { type: 'string', describe: 'Enformion galaxy-ap-password' })
    .option('ap-client-type', { type: 'string', default: 'NodeClient', describe: 'Enformion galaxy-client-type' })
    .option('ap-search-type', { type: 'string', default: 'DevAPIContactEnrich', describe: 'Enformion galaxy-search-type' })
    .option('ap-url', { type: 'string', default: 'https://devapi.enformion.com/Contact/Enrich', describe: 'Enformion API URL' })
    .option('max-rows', { type: 'number', describe: 'Limit number of rows (from bottom)' })
    .option('sleep', { type: 'number', default: 0.5, describe: 'Sleep between rows in seconds' })
    .option('log-level', { type: 'string', default: 'DEBUG', choices: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], describe: 'Console log level' })
    .help()
    .parse();

  setLogLevel(argv.logLevel);
  log('DEBUG', 'Starting enhanced pipeline with args:', argv);

  let enformion = null;
  if (argv.apName && argv.apPassword) {
    enformion = {
      apName: argv.apName,
      apPassword: argv.apPassword,
      clientType: argv.apClientType,
      searchType: argv.apSearchType,
      apiUrl: argv.apUrl,
      timeout: 25,
    };
  } else {
    log('WARNING', 'Enformion credentials not supplied; Enformion enrichment will be skipped.');
  }

  const config = {
    xlsxPath: argv.xlsx,
    outDir: argv.out,
    enformion,
    maxRows: argv.maxRows,
    sleepBetween: argv.sleep,
  };

  try {
    ConfigValidator.validate(config);
    const app = new BizfileEnricher(config);
    await app.run();
    log('INFO', 'Pipeline completed successfully');
  } catch (e) {
    log('CRITICAL', `Pipeline failed: ${e.message}`);
    if (e.stack) {
      log('DEBUG', `Stack trace: ${e.stack}`);
    }
    process.exit(1);
  }
})();
