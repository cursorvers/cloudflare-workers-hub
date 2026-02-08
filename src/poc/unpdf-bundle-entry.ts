// Intentionally tiny entry used for local bundle size measurement.
// Exporting the function forces bundlers to retain its dependency graph (including unpdf).
export { extractPdfText } from '../services/pdf-text-extractor';

