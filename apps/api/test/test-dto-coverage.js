/**
 * DTO Coverage Test
 * 
 * Test 1: Endpoint DTO Coverage
 * - Every endpoint in SPEC_INDEX.md must have:
 *   1) request DTO
 *   2) response DTO
 *   3) ApiErrorDto
 * 
 * Test 2: No Extra DTOs
 * - Fail if a DTO exists that is not referenced by API_CONTRACT.md or SPEC_PATCH.md
 */

const fs = require('fs');
const path = require('path');

// Colors for terminal output
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let errors = [];
let warnings = [];

// Read files - paths relative to apps/api/test/
const specIndexPath = path.join(__dirname, '../../../SPEC_INDEX.md');
const apiContractPath = path.join(__dirname, '../../../docs/API_CONTRACT.md');
const specPatchPath = path.join(__dirname, '../../../SPEC_PATCH.md');
const sharedDtoPath = path.join(__dirname, '../../../packages/shared/src/dto');

const specIndex = fs.readFileSync(specIndexPath, 'utf-8');
const apiContract = fs.readFileSync(apiContractPath, 'utf-8');
const specPatch = fs.readFileSync(specPatchPath, 'utf-8');

// Extract endpoints from SPEC_INDEX.md
function extractEndpoints(specIndex) {
  const endpoints = [];
  const endpointRegex = /- \*\*(GET|POST|PATCH|DELETE|PUT) ([^\*]+)\*\*/g;
  let match;
  
  while ((match = endpointRegex.exec(specIndex)) !== null) {
    const method = match[1];
    const path = match[2].trim();
    const endpointSection = specIndex.substring(
      match.index,
      specIndex.indexOf('---', match.index) !== -1 
        ? specIndex.indexOf('---', match.index)
        : specIndex.length
    );
    
    // Extract DTOs
    const requestDtoMatch = endpointSection.match(/Request DTO:\s*`?([^`\n]+)`?/);
    const responseDtoMatch = endpointSection.match(/Response DTO:\s*`?([^`\n]+)`?/);
    const errorDtoMatch = endpointSection.match(/Error DTO:\s*`?([^`\n]+)`?/);
    
    endpoints.push({
      method,
      path,
      requestDto: requestDtoMatch ? requestDtoMatch[1].trim() : null,
      responseDto: responseDtoMatch ? responseDtoMatch[1].trim() : null,
      errorDto: errorDtoMatch ? errorDtoMatch[1].trim() : null,
      raw: endpointSection
    });
  }
  
  return endpoints;
}

// Extract all DTOs from codebase
function extractDtosFromCodebase() {
  const dtos = new Set();
  
  if (!fs.existsSync(sharedDtoPath)) {
    return dtos;
  }
  
  const files = fs.readdirSync(sharedDtoPath);
  
  for (const file of files) {
    if (file.endsWith('.dto.ts')) {
      const content = fs.readFileSync(path.join(sharedDtoPath, file), 'utf-8');
      const interfaceRegex = /export\s+(interface|type)\s+(\w+Dto)\w*/g;
      let match;
      
      while ((match = interfaceRegex.exec(content)) !== null) {
        dtos.add(match[2]);
      }
    }
  }
  
  return dtos;
}

// Extract DTOs referenced in API_CONTRACT.md and SPEC_PATCH.md
function extractReferencedDtos(apiContract, specPatch) {
  const dtos = new Set();
  
  // Extract from API_CONTRACT.md - actual interface definitions
  const apiContractRegex = /export\s+(interface|type)\s+(\w+Dto)\w*/g;
  let match;
  
  while ((match = apiContractRegex.exec(apiContract)) !== null) {
    dtos.add(match[2]);
  }
  
  // Extract from SPEC_PATCH.md - interface definitions in additions
  const specPatchRegex = /export\s+(interface|type)\s+(\w+Dto)\w*/g;
  while ((match = specPatchRegex.exec(specPatch)) !== null) {
    dtos.add(match[2]);
  }
  
  // Also check for DTOs mentioned by name in API_CONTRACT.md text
  const dtoNameRegex = /`(\w+Dto)`/g;
  while ((match = dtoNameRegex.exec(apiContract)) !== null) {
    dtos.add(match[1]);
  }
  
  // Check SPEC_PATCH.md for DTOs mentioned as additions to API_CONTRACT.md
  // Look for patterns like "export interface XDto" in code blocks
  const specPatchCodeBlockRegex = /```typescript[\s\S]*?export\s+(interface|type)\s+(\w+Dto)\w*[\s\S]*?```/g;
  while ((match = specPatchCodeBlockRegex.exec(specPatch)) !== null) {
    const codeBlock = match[0];
    const interfaceMatch = codeBlock.match(/export\s+(interface|type)\s+(\w+Dto)\w*/);
    if (interfaceMatch) {
      dtos.add(interfaceMatch[2]);
    }
  }
  
  // Also check for DTO names in SPEC_PATCH.md text that reference API_CONTRACT additions
  const specPatchDtoRegex = /`(\w+Dto)`/g;
  while ((match = specPatchDtoRegex.exec(specPatch)) !== null) {
    // Only add if it's in a section about API_CONTRACT.md
    const context = specPatch.substring(Math.max(0, match.index - 200), match.index + 200);
    if (context.includes('API_CONTRACT') || context.includes('API_CONTRACT.md')) {
      dtos.add(match[1]);
    }
  }
  
  return dtos;
}

// Run tests
console.log('Running DTO Coverage Tests...\n');

// Test 1: Endpoint DTO Coverage
console.log('Test 1: Endpoint DTO Coverage');
console.log('='.repeat(50));

const endpoints = extractEndpoints(specIndex);
console.log(`Found ${endpoints.length} endpoints in SPEC_INDEX.md\n`);

for (const endpoint of endpoints) {
  const { method, path, requestDto, responseDto, errorDto } = endpoint;
  const endpointName = `${method} ${path}`;
  
  console.log(`Checking ${endpointName}...`);
  console.log(`  Request DTO: ${requestDto || 'None'}`);
  console.log(`  Response DTO: ${responseDto || 'None'}`);
  console.log(`  Error DTO: ${errorDto || 'None'}`);
  
  // Check for ApiErrorDto (required for all endpoints)
  if (!errorDto || errorDto.toLowerCase() !== 'apierrordto') {
    errors.push(`❌ ${endpointName}: Missing or incorrect Error DTO. Expected 'ApiErrorDto', got '${errorDto || 'None'}'`);
  }
  
  // Check for request DTO (may be None for GET/DELETE without body)
  if (method === 'GET' || method === 'DELETE') {
    if (requestDto && requestDto.toLowerCase() !== 'none') {
      // This is fine, some GET/DELETE endpoints may have request DTOs
    }
  } else {
    // POST, PATCH, PUT must have request DTO
    if (!requestDto || requestDto.toLowerCase() === 'none') {
      errors.push(`❌ ${endpointName}: Missing Request DTO (required for ${method})`);
    }
  }
  
  // Check for response DTO
  if (!responseDto || responseDto.toLowerCase() === 'none') {
    // Some endpoints may return HTTP 200 OK without a body
    if (method === 'DELETE' && responseDto && responseDto.includes('HTTP 200 OK')) {
      // This is acceptable
    } else {
      warnings.push(`⚠️  ${endpointName}: No explicit Response DTO specified`);
    }
  }
  
  console.log('');
}

// Test 2: No Extra DTOs
console.log('\nTest 2: No Extra DTOs');
console.log('='.repeat(50));

const codebaseDtos = extractDtosFromCodebase();
const referencedDtos = extractReferencedDtos(apiContract, specPatch);

console.log(`Found ${codebaseDtos.size} DTOs in codebase:`);
codebaseDtos.forEach(dto => console.log(`  - ${dto}`));

console.log(`\nFound ${referencedDtos.size} DTOs referenced in API_CONTRACT.md or SPEC_PATCH.md:`);
referencedDtos.forEach(dto => console.log(`  - ${dto}`));

console.log('');

for (const dto of codebaseDtos) {
  if (!referencedDtos.has(dto)) {
    errors.push(`❌ DTO '${dto}' exists in codebase but is not referenced in API_CONTRACT.md or SPEC_PATCH.md`);
  }
}

// Print results
console.log('\nResults:');
console.log('='.repeat(50));

if (errors.length === 0 && warnings.length === 0) {
  console.log(`${GREEN}✓ All tests passed!${RESET}`);
  process.exit(0);
} else {
  if (warnings.length > 0) {
    console.log(`\n${YELLOW}Warnings:${RESET}`);
    warnings.forEach(w => console.log(`  ${w}`));
  }
  
  if (errors.length > 0) {
    console.log(`\n${RED}Errors:${RESET}`);
    errors.forEach(e => console.log(`  ${e}`));
    console.log(`\n${RED}❌ Tests failed with ${errors.length} error(s)${RESET}`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}✓ Tests passed with ${warnings.length} warning(s)${RESET}`);
    process.exit(0);
  }
}
