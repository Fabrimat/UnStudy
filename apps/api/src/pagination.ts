import { Prisma } from '@summarize/db';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { PrismaService } from './prisma.service';

export class PageQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

// items and count share one transaction so they see the same snapshot.
export async function page<T>(
  prisma: PrismaService,
  q: PageQueryDto,
  items: (p: { skip: number; take: number }) => Prisma.PrismaPromise<T[]>,
  total: Prisma.PrismaPromise<number>,
): Promise<Page<T>> {
  const [rows, count] = await prisma.$transaction([items({ skip: (q.page - 1) * q.pageSize, take: q.pageSize }), total]);
  return { items: rows, total: count, page: q.page, pageSize: q.pageSize };
}
