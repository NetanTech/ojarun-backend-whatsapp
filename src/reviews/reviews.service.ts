import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto } from './dto/review.dto';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async findMine(customerId: string) {
    const reviews = await this.prisma.orderReview.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
    return reviews.map((review) => this.serialize(review));
  }

  async findForOrder(customerId: string, orderId: string) {
    const review = await this.prisma.orderReview.findUnique({
      where: { orderId },
    });
    if (!review || review.customerId !== customerId) {
      throw new NotFoundException('Review not found');
    }
    return this.serialize(review);
  }

  async create(customerId: string, orderId: string, dto: CreateReviewDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.customerId !== customerId) {
      throw new ForbiddenException('This order does not belong to you');
    }
    if (order.status !== OrderStatus.delivered) {
      throw new BadRequestException('Only delivered orders can be reviewed');
    }

    try {
      const review = await this.prisma.orderReview.create({
        data: {
          orderId,
          customerId,
          overallRating: dto.overallRating,
          qualityRating: dto.qualityRating,
          deliveryRating: dto.deliveryRating,
          comment: dto.comment,
          photoUrls: dto.photoUrls ?? [],
        },
      });
      return this.serialize(review);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('This order has already been reviewed');
      }
      throw err;
    }
  }

  private serialize(review: {
    id: string;
    orderId: string;
    overallRating: number;
    qualityRating: number;
    deliveryRating: number;
    comment: string | null;
    photoUrls: string[];
    createdAt: Date;
  }) {
    return {
      id: review.id,
      orderId: review.orderId,
      overallRating: review.overallRating,
      qualityRating: review.qualityRating,
      deliveryRating: review.deliveryRating,
      comment: review.comment,
      photoUrls: review.photoUrls,
      createdAt: review.createdAt,
    };
  }
}
