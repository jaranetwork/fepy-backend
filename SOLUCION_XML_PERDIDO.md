# Solución: Pérdida de XML y KUDE por Error de Conexión a SET

## Problema Detectado

Si había un **error de conexión** al enviar la factura al SET (o mock-set), el sistema **no guardaba el XML ni el KUDE**, perdiendo todo el trabajo de generación y firma.

### Flujo Original (CON ERROR)

```
1. Generar XML         ✅ Completado
2. Firmar XML          ✅ Completado
3. Agregar QR          ✅ Completado
4. Enviar a SET        ❌ ERROR DE CONEXIÓN
5. Guardar XML         ⏸️ NUNCA SE EJECUTA (está después del envío)
6. Generar KUDE        ⏸️ NUNCA SE EJECUTA
```

### Código Problemático (antes)

```javascript
// 8. Enviar a SET
const soapResponse = await setApi.recibe(...);  // ❌ Si falla aquí...

// 9. Guardar XML  ← NUNCA SE EJECUTA SI HAY ERROR
fs.writeFileSync(rutaArchivo, xmlConQR);
```

## Solución Implementada

### Nuevo Flujo (CORREGIDO)

```
1. Generar XML         ✅ Completado
2. Firmar XML          ✅ Completado
3. Agregar QR          ✅ Completado
4. GUARDAR XML         ✅ SE GUARDA INMEDIATAMENTE
5. Enviar a SET        ⚠️ Si falla, el XML YA ESTÁ GUARDADO
6. Generar KUDE        ✅ SE GENERA (el XML existe)
```

### Código Corregido (ahora)

```javascript
// 8. GUARDAR XML INMEDIATAMENTE (ANTES DE ENVIAR A SET)
// CRÍTICO: Guardar el XML firmado ANTES de enviar a SET para no perderlo si falla la conexión
const rutaArchivo = path.join(rutaSalida, nombreArchivo);
fs.writeFileSync(rutaArchivo, xmlConQR);  // ✅ GUARDADO PRIMERO
console.log(`📁 XML guardado: ${rutaArchivo}`);

// 9. Enviar a SET - AHORA EL XML YA ESTÁ GUARDADO
let soapResponse = null;
let errorEnvio = null;

try {
  soapResponse = await setApi.recibe(...);
} catch (setErr) {
  // ⚠️ ERROR DE CONEXIÓN: No perder el XML ya generado
  errorEnvio = setErr;
  console.warn('⚠️ Error enviando a SET:', setErr.message);
  console.warn('⚠️ El XML firmado ya está guardado en:', rutaArchivo);
  soapResponse = null;
}

// 10. Extraer datos de respuesta (o usar valores por error)
let estadoSifen = 'enviado';
if (soapResponse) {
  // Éxito: extraer datos normales
  estadoSifen = determinarEstadoSegunCodigoRetorno(...);
} else {
  // Error de conexión: establecer estado de error
  estadoSifen = 'error';
  mensajeRetorno = errorEnvio?.message || 'Error de conexión con SET';
  codigoRetorno = '9999';
}

// 11. Retornar resultado (el XML ya está guardado)
return {
  success: true,
  xmlPath: xmlPathRelativo,
  rutaArchivo: rutaArchivo,  // ← Disponible para KUDE
  estado: estadoSifen,       // ← 'error' si falló conexión
  ...
};
```

## Beneficios

| Antes | Ahora |
|-------|-------|
| ❌ XML se perdía si fallaba SET | ✅ XML siempre se guarda |
| ❌ KUDE no se generaba | ✅ KUDE se genera (XML existe) |
| ❌ Tenías que reintentar todo | ✅ Puedes reintentar solo el envío |
| ❌ Sin rastro del documento | ✅ XML firmado disponible |

## Estados SIFEN Actualizados

| Estado | Cuándo ocurre | ¿XML guardado? | ¿KUDE generado? |
|--------|---------------|----------------|-----------------|
| `aceptado` | SET aprobó la factura | ✅ Sí | ✅ Sí |
| `rechazado` | SET rechazó la factura | ✅ Sí | ✅ Sí |
| `error` | **Error de conexión** | ✅ **Sí** | ✅ **Sí** |

## Recuperación ante Error de Conexión

Si hay un error de conexión al SET:

1. ✅ **El XML firmado está guardado** en `de_output/AAAA/MM/`
2. ✅ **El KUDE se puede generar** desde el XML guardado
3. ✅ **Los datos están en la BD** con estado `error`
4. ✅ **Puedes reintentar el envío** consultando el CDC o usando el XML guardado

## Logs Esperados

### Éxito
```
📝 Generando XML...
✍️  Firmando XML...
📱 Generando QR...
📁 XML guardado: /home/ruben/sifen_einvoice/de_output/2026/02/Factura_12345678-001-001-0000060.xml
📤 Enviando a SET...
📄 Respuesta SET recibida
📋 Código: 0000, Estado: aceptado
```

### Error de Conexión
```
📝 Generando XML...
✍️  Firmando XML...
📱 Generando QR...
📁 XML guardado: /home/ruben/sifen_einvoice/de_output/2026/02/Factura_12345678-001-001-0000060.xml
📤 Enviando a SET...
⚠️ Error enviando a SET: connect ECONNREFUSED 127.0.0.1:8082
⚠️ El XML firmado ya está guardado en: /home/ruben/sifen_einvoice/de_output/2026/02/Factura_...xml
❌ Estado: error - Error de conexión con SET
```

## Archivos Modificados

- `services/procesarFacturaService.js` - Guarda XML antes de enviar a SET

## Pruebas Recomendadas

1. **Detener el mock-set** y enviar una factura
2. **Verificar** que el XML está guardado en `de_output/`
3. **Verificar** que la BD tiene el registro con estado `error`
4. **Reiniciar mock-set** y consultar el estado usando el CDC

---
**Fecha:** 2026-02-26
**Problema:** Pérdida de XML/KUDE por error de conexión
**Solución:** Guardar XML antes de enviar a SET
