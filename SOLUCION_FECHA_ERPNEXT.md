# Solución: Error "Invalid time value" con fechas de ERPNext

## Problema

ERPNext envía fechas con **microsegundos** (6 dígitos): `2026-02-24T15:12:58.715809`

JavaScript espera fechas con **milisegundos** (3 dígitos): `2026-02-24T15:12:58.715Z`

Esto causaba el error: `Invalid time value` cuando se intentaba procesar facturas desde ERPNext.

## Solución Implementada

### 1. Nuevo archivo utilitario: `utils/fechaUtils.js`

Crea funciones reutilizables para normalización de fechas:

- `normalizarDatetime(datetimeStr)` - Convierte microsegundos → milisegundos
- `normalizarFechasEnObjeto(obj)` - Normaliza recursivamente todas las fechas en un objeto
- `esFechaValida(fecha)` - Valida si una fecha es correcta

### 2. Archivos modificados

#### `routes/facturar.js`
```javascript
const { normalizarFechasEnObjeto, normalizarDatetime } = require('../utils/fechaUtils');

// Al inicio del endpoint POST /api/facturar/crear:
datosFactura = normalizarFechasEnObjeto(datosFactura);
```

#### `routes/get_einvoice.js`
```javascript
const { normalizarFechasEnObjeto, normalizarDatetime } = require('../utils/fechaUtils');

// Al inicio del endpoint POST /get_einvoice:
datosFactura = normalizarFechasEnObjeto(datosFactura);
```

#### `controllers/facturaController.js`
```javascript
const { normalizarFechasEnObjeto, normalizarDatetime } = require('../utils/fechaUtils');

// INMEDIATAMENTE después de obtener datosFactura:
datosFactura = normalizarFechasEnObjeto(datosFactura);

// Luego, usar datosFactura.fecha ya está normalizada
```

#### `services/procesarFacturaService.js`
```javascript
const { normalizarDatetime } = require('../utils/fechaUtils');

// Elimina la función local y usa la del utilitario
```

## Flujo Correcto de Procesamiento

### Orden de operaciones en controllers/facturaController.js:

```javascript
exports.generarFactura = async (req, res) => {
  try {
    const { ruc, ...datosFactura } = req.body;  // ← 1. Recibir datos

    // ← 2. NORMALIZAR INMEDIATAMENTE (CRÍTICO!)
    datosFactura = normalizarFechasEnObjeto(datosFactura);

    // ← 3. Ahora TODOS los usos de datosFactura.fecha usan la versión normalizada
    const facturaHash = generarFacturaHash({
      fecha: datosFactura.fecha  // ✅ Ya está normalizada
    });

    const invoice = new Invoice({
      datosFactura: datosFactura  // ✅ Se guarda normalizado en BD
    });
  }
}
```

## ¿Por qué el orden es crítico?

### ❌ Orden INCORRECTO (causa el error):

```javascript
const { ruc, ...datosFactura } = req.body;

// Usar datosFactura.fecha AQUÍ → TIENE MICROSEGUNDOS
const facturaHash = generarFacturaHash({
  fecha: datosFactura.fecha  // ❌ 2026-02-24T15:12:58.715809
});

// Normalizar DESPUÉS → DEMASIADO TARDE
datosFactura = normalizarFechasEnObjeto(datosFactura);
```

### ✅ Orden CORRECTO:

```javascript
const { ruc, ...datosFactura } = req.body;

// Normalizar PRIMERO → CRÍTICO!
datosFactura = normalizarFechasEnObjeto(datosFactura);

// Usar datosFactura.fecha AQUÍ → YA ESTÁ NORMALIZADA
const facturaHash = generarFacturaHash({
  fecha: datosFactura.fecha  // ✅ 2026-02-24T15:12:58.715Z
});
```

## Cómo Funciona

### Flujo Completo (3 pasos):

```
ERPNext → 2026-02-24T15:12:58.715809 (microsegundos)
         ↓
   [1] normalizarFechasEnObjeto()
         ↓
   2026-02-24T15:12:58.715Z (para JavaScript/BD)
         ↓
   [2] formatoFechaSIFEN() → para un campo específico
   [3] convertirFechasASIFEN() → para objeto completo
         ↓
   2026-02-24T15:12:58 (para librería xmlgen)
         ↓
   ✅ Válido para ambos
```

### ¿Por qué 3 pasos?

| Paso | Función | Formato Resultado | Para qué |
|------|---------|-------------------|----------|
| **1** | `normalizarFechasEnObjeto()` | `2026-02-24T15:12:58.715Z` | BD y JavaScript |
| **2** | `formatoFechaSIFEN()` | `2026-02-24T15:12:58` | Un campo específico |
| **3** | `convertirFechasASIFEN()` | Todo el objeto | Librería xmlgen |

### Punto Crítico en procesarFacturaService.js:

```javascript
// ANTES de llamar a xmlgen (línea ~118)
console.log('📅 Convirtiendo fechas a formato SIFEN para xmlgen...');
datosCompletos = convertirFechasASIFEN(datosCompletos);

const xmlGenerado = await FacturaElectronicaPY.generateXMLDE(params, datosCompletos, {});
```

## Formatos de Fecha

| Contexto | Formato | Ejemplo | Función |
|----------|---------|---------|---------|
| **ERPNext** | ISO con microsegundos | `2026-02-24T15:12:58.715809` | - |
| **JavaScript/BD** | ISO con milisegundos | `2026-02-24T15:12:58.715Z` | `normalizarDatetime()` |
| **Librería SIFEN** | ISO sin milisegundos ni Z | `2026-02-24T15:12:58` | `formatoFechaSIFEN()` |

## Campos de Fecha Normalizados

La función `normalizarFechasEnObjeto()` busca y normaliza estos campos:
- `fecha`
- `fecha_nacimiento`
- `fecha_emision`
- `fecha_vencimiento`
- `created`
- `modified`

## Pruebas

Ejecutar test de validación:
```bash
cd /home/ruben/sifen_einvoice/proyecto-sifen/fepy-backend
node test_fecha_utils.js
```

Resultado esperado:
```
✅ Pasados: 9
❌ Fallidos: 0
✅ Las fechas de ERPNext se normalizaron correctamente
```

## Ejemplo de Uso

### Desde ERPNext:
```json
{
  "ruc": "80012345-1",
  "numero": "0000060",
  "fecha": "2026-02-24T15:12:58.715809",
  "cliente": { ... },
  "items": [ ... ]
}
```

### Después de normalizar:
```json
{
  "ruc": "80012345-1",
  "numero": "0000060",
  "fecha": "2026-02-24T15:12:58.715Z",
  "cliente": { ... },
  "items": [ ... ]
}
```

## Beneficios

1. ✅ **No más errores de fecha** - Las fechas de ERPNext se procesan correctamente
2. ✅ **Transparente** - No requiere cambios en ERPNext
3. ✅ **Centralizado** - Una sola función maneja todas las normalizaciones
4. ✅ **Reutilizable** - Cualquier módulo puede usar `fechaUtils.js`
5. ✅ **Robusto** - Maneja fechas inválidas, null, undefined

## Archivos Involucrados

```
proyecto-sifen/fepy-backend/
├── utils/
│   └── fechaUtils.js          # ✨ NUEVO: Utilidades de fecha
├── routes/
│   ├── facturar.js            # ✏️ Actualizado
│   └── get_einvoice.js        # ✏️ Actualizado
├── controllers/
│   └── facturaController.js   # ✏️ Actualizado
├── services/
│   └── procesarFacturaService.js  # ✏️ Actualizado
└── test_fecha_utils.js        # ✨ NUEVO: Tests de validación
```

## Reinicio Requerido

Después de aplicar estos cambios, reiniciar el backend:

```bash
# Detener backend (Ctrl+C)
cd /home/ruben/sifen_einvoice/proyecto-sifen/fepy-backend
npm start
```

## Verificación

Para verificar que el cambio está funcionando:

1. Enviar una factura desde ERPNext con fecha normal
2. Ver logs del backend:
```
📅 Normalizando fechas de ERPNext...
  Fecha original: 2026-02-24T15:12:58.715809
  Fecha normalizada: 2026-02-24T15:12:58.715Z
```

3. La factura debería procesarse sin error "Invalid time value"

---
**Fecha de solución:** 2026-02-25
**Autor:** Asistente de Código
