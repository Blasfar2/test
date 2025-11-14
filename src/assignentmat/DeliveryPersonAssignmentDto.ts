export class DeliveryPersonAssignmentDto {
  orderNumber: string;
  deliveryPersonId: string;
}

export class BulkDeliveryPersonAssignmentDto {
  assignments: DeliveryPersonAssignmentDto[];
}

export interface DeliveryPersonAssignmentPayload {
  orderId: string;
  orderNumber: string;
  deliveryPersonId: string;
}

export interface DeliveryAssignmentResult {
  orderNumber: string;
  deliveryPersonId: string;
  success: boolean;
  error?: string;
}

export const CT_CUSTOM_FIELDS = {
  ORDER: {
    DELIVERY_PERSON_ID: 'deliveryPersonId',
    DELIVERY_PERSON_NAME: 'deliveryPersonName',
  },
};