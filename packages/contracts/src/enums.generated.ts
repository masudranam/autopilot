/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced from `apps/api/prisma/schema.prisma` by `pnpm gen:enums`.
 * `pnpm check:repo` fails if this file and the schema disagree, so editing it by
 * hand is a check failure rather than a silent second source of truth.
 */

export const AddressKind = {
  SHIPPING: 'SHIPPING',
  BILLING: 'BILLING',
} as const;

export type AddressKind = (typeof AddressKind)[keyof typeof AddressKind];

/** Every AddressKind value, in schema declaration order. */
export const ADDRESS_KIND_VALUES = [
  AddressKind.SHIPPING,
  AddressKind.BILLING,
] as const satisfies readonly AddressKind[];

export const CheckoutStatus = {
  STARTED: 'STARTED',
  ADDRESS_SET: 'ADDRESS_SET',
  SHIPPING_SELECTED: 'SHIPPING_SELECTED',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;

export type CheckoutStatus = (typeof CheckoutStatus)[keyof typeof CheckoutStatus];

/** Every CheckoutStatus value, in schema declaration order. */
export const CHECKOUT_STATUS_VALUES = [
  CheckoutStatus.STARTED,
  CheckoutStatus.ADDRESS_SET,
  CheckoutStatus.SHIPPING_SELECTED,
  CheckoutStatus.PAYMENT_PENDING,
  CheckoutStatus.CONFIRMED,
  CheckoutStatus.FAILED,
  CheckoutStatus.EXPIRED,
] as const satisfies readonly CheckoutStatus[];

export const OrderStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FULFILLING: 'FULFILLING',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  RETURNED: 'RETURNED',
  REFUNDED: 'REFUNDED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Every OrderStatus value, in schema declaration order. */
export const ORDER_STATUS_VALUES = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
  OrderStatus.REFUNDED,
] as const satisfies readonly OrderStatus[];

export const PaymentStatus = {
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  DECLINED: 'DECLINED',
  FAILED: 'FAILED',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Every PaymentStatus value, in schema declaration order. */
export const PAYMENT_STATUS_VALUES = [
  PaymentStatus.PENDING,
  PaymentStatus.AUTHORIZED,
  PaymentStatus.CAPTURED,
  PaymentStatus.DECLINED,
  PaymentStatus.FAILED,
] as const satisfies readonly PaymentStatus[];

export const ProductStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/** Every ProductStatus value, in schema declaration order. */
export const PRODUCT_STATUS_VALUES = [
  ProductStatus.DRAFT,
  ProductStatus.PUBLISHED,
  ProductStatus.ARCHIVED,
] as const satisfies readonly ProductStatus[];

export const PromotionType = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  FREE_SHIPPING: 'FREE_SHIPPING',
} as const;

export type PromotionType = (typeof PromotionType)[keyof typeof PromotionType];

/** Every PromotionType value, in schema declaration order. */
export const PROMOTION_TYPE_VALUES = [
  PromotionType.PERCENTAGE,
  PromotionType.FIXED_AMOUNT,
  PromotionType.FREE_SHIPPING,
] as const satisfies readonly PromotionType[];

export const RefundStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

/** Every RefundStatus value, in schema declaration order. */
export const REFUND_STATUS_VALUES = [
  RefundStatus.PENDING,
  RefundStatus.SUCCEEDED,
  RefundStatus.FAILED,
] as const satisfies readonly RefundStatus[];

export const ReturnStatus = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  RECEIVED: 'RECEIVED',
  REFUNDED: 'REFUNDED',
} as const;

export type ReturnStatus = (typeof ReturnStatus)[keyof typeof ReturnStatus];

/** Every ReturnStatus value, in schema declaration order. */
export const RETURN_STATUS_VALUES = [
  ReturnStatus.REQUESTED,
  ReturnStatus.APPROVED,
  ReturnStatus.REJECTED,
  ReturnStatus.RECEIVED,
  ReturnStatus.REFUNDED,
] as const satisfies readonly ReturnStatus[];

export const ReviewStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;

export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

/** Every ReviewStatus value, in schema declaration order. */
export const REVIEW_STATUS_VALUES = [
  ReviewStatus.PENDING,
  ReviewStatus.APPROVED,
  ReviewStatus.REJECTED,
] as const satisfies readonly ReviewStatus[];

export const Role = {
  CUSTOMER: 'CUSTOMER',
  SUPPORT: 'SUPPORT',
  ADMIN: 'ADMIN',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/** Every Role value, in schema declaration order. */
export const ROLE_VALUES = [
  Role.CUSTOMER,
  Role.SUPPORT,
  Role.ADMIN,
] as const satisfies readonly Role[];

export const ShipmentStatus = {
  PREPARING: 'PREPARING',
  DISPATCHED: 'DISPATCHED',
  DELIVERED: 'DELIVERED',
} as const;

export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

/** Every ShipmentStatus value, in schema declaration order. */
export const SHIPMENT_STATUS_VALUES = [
  ShipmentStatus.PREPARING,
  ShipmentStatus.DISPATCHED,
  ShipmentStatus.DELIVERED,
] as const satisfies readonly ShipmentStatus[];

export const ShippingRateType = {
  FLAT: 'FLAT',
  WEIGHT_BANDED: 'WEIGHT_BANDED',
  FREE_OVER_THRESHOLD: 'FREE_OVER_THRESHOLD',
} as const;

export type ShippingRateType = (typeof ShippingRateType)[keyof typeof ShippingRateType];

/** Every ShippingRateType value, in schema declaration order. */
export const SHIPPING_RATE_TYPE_VALUES = [
  ShippingRateType.FLAT,
  ShippingRateType.WEIGHT_BANDED,
  ShippingRateType.FREE_OVER_THRESHOLD,
] as const satisfies readonly ShippingRateType[];
