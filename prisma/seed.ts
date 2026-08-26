import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.creator.upsert({
    where: { handle: "maison_jenflox" },
    update: {},
    create: {
      handle: "maison_jenflox",
      curatorShopUrl: "https://www.musinsa.com/curator/s/maison_jenflox",
      sizeProfile: JSON.stringify({
        height: 168,
        weight: 62,
        usualTop: "M",
        usualBottom: "30",
      }),
    },
  });
  console.log("시드 완료: creator 'maison_jenflox'");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
