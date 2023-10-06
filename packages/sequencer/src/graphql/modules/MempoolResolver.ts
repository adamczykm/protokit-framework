/* eslint-disable new-cap,id-length */
import { Arg, Field, InputType, Mutation, Query, Resolver } from "type-graphql";
import { inject, injectable } from "tsyringe";
import { IsNumberString } from "class-validator";

import { Mempool } from "../../mempool/Mempool.js";
import { PendingTransaction } from "../../mempool/PendingTransaction.js";
import { GraphqlModule } from "../GraphqlModule.js";

@InputType()
class Signature {
  @Field()
  @IsNumberString()
  public r: string;

  @Field()
  @IsNumberString()
  public s: string;

  public constructor(r: string, s: string) {
    this.r = r;
    this.s = s;
  }
}

@InputType()
class TransactionObject {
  @Field()
  @IsNumberString()
  public methodId: string;

  @Field()
  public sender: string;

  @Field()
  @IsNumberString()
  public nonce: string;

  @Field(() => Signature)
  public signature: Signature;

  @Field(() => [String])
  public args: string[];

  public constructor(
    methodId: string,
    sender: string,
    nonce: string,
    signature: Signature,
    args: string[]
  ) {
    this.methodId = methodId;
    this.sender = sender;
    this.nonce = nonce;
    this.signature = signature;
    this.args = args;
  }
}

@injectable()
@Resolver(TransactionObject)
export class MempoolResolver extends GraphqlModule<object> {
  public resolverType = MempoolResolver;

  private readonly mempool: Mempool;

  public constructor(@inject("Mempool") mempool: Mempool) {
    super();
    this.mempool = mempool;
  }

  @Mutation(() => String)
  public submitTx(@Arg("tx") tx: TransactionObject): string {
    const decoded = PendingTransaction.fromJSON(tx);
    this.mempool.add(decoded);

    return decoded.hash().toString();
  }

  @Query(() => String)
  public transactionState(@Arg("hash") hash: string) {
    const tx = this.mempool
      .getTxs()
      .txs.find((x) => x.hash().toString() === hash);

    if (tx) {
      return "pending";
    }

    return "unknown";
  }

  @Query(() => [String])
  public transactions(){
      let tx = this.mempool.getTxs().txs
      return tx.map(x => x.hash().toString())
  }

  // @Query(returns => [TransactionObject])
  // transaction(
  //     @Arg("hash") hash: string
  // ){
  //
  // eslint-disable-next-line max-len
  //     let tx = this.mempool.getTxs().txs.find(x => x.hash().toString() === hash) //TODO Not very performant
  //
  //     if(tx){
  //         let parsed = tx.toJSON()
  //         return [parsed]
  //     }else{
  //         return []
  //     }
  // }
}