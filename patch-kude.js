/**
 * Script para parchar librerías de facturación electrónica
 * Ejecutar después de cada `npm install`
 * 
 * Uso: node patch-kude.js
 */

const fs = require('fs');
const path = require('path');

// ========================================
// PARCHE 1: facturacionelectronicapy-kude
// ========================================
const kudeIndexPath = path.join(__dirname, 'node_modules/facturacionelectronicapy-kude/dist/index.js');

// Contenido original (con 4 parámetros)
const kudeOriginalContent = `this.generateKUDE = (java8Path, xmlSigned, urlLogo, ambiente) => {
            return KUDEGen_1.default.generateKUDE(java8Path, xmlSigned, urlLogo, ambiente);`;

// Contenido parcheado (con 5 parámetros)
const kudePatchedContent = `this.generateKUDE = (java8Path, xmlSigned, srcJasper, destFolder, jsonParam) => {
            return KUDEGen_1.default.generateKUDE(java8Path, xmlSigned, srcJasper, destFolder, jsonParam);`;

// ========================================
// PARCHE 2: facturacionelectronicapy-qrgen (opcional, por si cambia)
// ========================================
const qrIndexPath = path.join(__dirname, 'node_modules/facturacionelectronicapy-qrgen/dist/index.js');

// Contenido original
const qrOriginalContent = `this.generateQR = (xmlSigned, idCSC, CSC, env) => {
            return QRGen_1.default.generateQR(xmlSigned, idCSC, CSC, env);`;

// Contenido parcheado (mismo contenido, solo para verificar)
const qrPatchedContent = `this.generateQR = (xmlSigned, idCSC, CSC, env) => {
            return QRGen_1.default.generateQR(xmlSigned, idCSC, CSC, env);`;

// ========================================
// APLICAR PARCHE KUDE
// ========================================
try {
  if (!fs.existsSync(kudeIndexPath)) {
    console.error('❌ Error: No se encontró el archivo KUDE index.js en:', kudeIndexPath);
    console.error('   Asegurate de haber ejecutado `npm install` en fepy-backend');
  } else {
    let content = fs.readFileSync(kudeIndexPath, 'utf8');

    // Verificar si ya está parcheado (tiene los 5 parámetros)
    if (content.includes('srcJasper, destFolder, jsonParam')) {
      console.log('✓ El parche de KUDE ya está aplicado');
    } else {
      // Intentar parche con el contenido original conocido
      if (content.includes(kudeOriginalContent)) {
        content = content.replace(kudeOriginalContent, kudePatchedContent);
        fs.writeFileSync(kudeIndexPath, content, 'utf8');
        console.log('✅ Parche aplicado exitosamente a facturacionelectronicapy-kude');
        console.log('   Archivo:', kudeIndexPath);
        console.log('   Parámetros: java8Path, xmlSigned, srcJasper, destFolder, jsonParam');
      } else {
        // Si no coincide el contenido exacto, intentar con regex más flexible
        // Busca cualquier versión de generateKUDE con 4 parámetros y la reemplaza con 5
        const flexiblePattern = /this\.generateKUDE\s*=\s*\([^)]+\)\s*=>\s*\{\s*return\s+KUDEGen_1\.default\.generateKUDE\([^)]+\)/;
        
        if (flexiblePattern.test(content)) {
          const flexibleReplacement = `this.generateKUDE = (java8Path, xmlSigned, srcJasper, destFolder, jsonParam) => {
            return KUDEGen_1.default.generateKUDE(java8Path, xmlSigned, srcJasper, destFolder, jsonParam)`;
          
          content = content.replace(flexiblePattern, flexibleReplacement);
          fs.writeFileSync(kudeIndexPath, content, 'utf8');
          console.log('✅ Parche aplicado (modo flexible) a facturacionelectronicapy-kude');
          console.log('   Archivo:', kudeIndexPath);
        } else {
          console.warn('⚠️ Advertencia: El contenido del archivo KUDE no coincide con lo esperado');
          console.warn('   Es posible que la librería haya cambiado su estructura');
          console.warn('   Verificar archivo:', kudeIndexPath);
        }
      }
    }
  }
} catch (error) {
  console.error('❌ Error al aplicar el parche de KUDE:', error.message);
}

// ========================================
// VERIFICAR PARCHE QR (opcional)
// ========================================
try {
  if (fs.existsSync(qrIndexPath)) {
    let content = fs.readFileSync(qrIndexPath, 'utf8');
    if (content.includes(qrOriginalContent)) {
      console.log('✓ facturacionelectronicapy-qrgen está correcto (no requiere parche)');
    } else {
      console.warn('⚠️ Advertencia: facturacionelectronicapy-qrgen tiene una estructura diferente');
    }
  }
} catch (error) {
  console.error('⚠️ Error al verificar QR:', error.message);
}
