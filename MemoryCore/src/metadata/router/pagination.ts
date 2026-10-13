/** Re-export for router/schemas (implementation in metadata/pagination.ts). */
export {
  paginationInputSchema,
  resolvePagination,
  toPaginationParams,
  wrapPaginated,
  paginateArray,
  formatListResult,
  isPaginatedResult,
  unwrapListItems,
  DEFAULT_PAGINATION,
} from "../pagination.js";
