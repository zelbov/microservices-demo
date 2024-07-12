import { randomUUID } from "crypto";
import { DefaultSagaRequestType, DefaultSagaResponseType } from "../types/Saga.types";
import { SagaQueuesAdapter } from "../types/SagaQueuesAdapter.types";
import { SagaResponseChannelAdapter } from "../types/SagaResponseChannelAdapter.types";
import { SagaContext } from "./SagaContext";

type SagaResponseAsError<ErrorDataType extends DefaultSagaResponseType> = { response: ErrorDataType, kind: 'error' }
type SagaResponseAsSuccess<ResponseDataType extends DefaultSagaResponseType> = { response: ResponseDataType, kind: 'success' }

/**
 * Used as a middleware network provider for running Sagas from request entrypoints 
 * and distributing responses to microservices that are subscribed to Saga execution results
 */
export class SagaOperator {

    private queue_adapter?: SagaQueuesAdapter;

    private response_channel_adapter?: SagaResponseChannelAdapter;

    constructor() {}

    /**
     * Assigns queue service adapter, which is used to deliver Saga requests to a cluster and consume Saga execution results
     */
    useQueueAdapter<
        AdapterType extends SagaQueuesAdapter,
    >(adapter: AdapterType) {

        this.queue_adapter = adapter
        return this;

    }

    /**
     * Assigns publication channel service adapter, which is used to instantiate dedicated short-living queues to deliver messages to Saga executor
     */
    useResponseChannelAdapter<
        AdapterType extends SagaResponseChannelAdapter,
    >(adapter: AdapterType) {

        this.response_channel_adapter = adapter
        return this;

    }

    private contexts: {[key: string]: SagaContext} = {}

    private initSagaSub(context: SagaContext) {

        this.queue_adapter!.subscribeToSagaQueue(
            context.outputQueueName!,
            (response) => {

                this.response_channel_adapter!.publishResponse(
                    response
                )

            }
        )

    }

    private initSagaDlqSub(context: SagaContext) {

        if(context.deadLetterQueueName)
        this.queue_adapter!.subscribeToSagaDLQ(
            context.deadLetterQueueName,
            (dead) => {

                this.response_channel_adapter!.publishError(dead)

            }
        )

    }

    /**
     * Sets up listeners for message queues defined in a SagaContext and delivers responses to dedicated consumers queues. 
     * Should be only called once per SagaContext. 
     * If a context is passed into `executeTask` call without initial setup, it will be set up automatically.
     */
    setupContext(context: SagaContext) {

        if(this.contexts[context.name])
            throw new Error(`SagaOperator have already set up context "${context.name}"`)
        this.contexts[context.name] = context

        if(!this.queue_adapter)
            throw new Error('Cannot setup Saga context for use by operator without message broker queues adapter')
        if(!this.response_channel_adapter)
            throw new Error('Cannot setup Saga coontext for use by operator without response publication channels adapter')

        if(!context.inputQueueName) throw new Error('Input queue name is not specified in SagaContext')
        if(!context.outputQueueName) throw new Error('Output queue name is not specified in SagaContext')

        this.initSagaSub(context)
        this.initSagaDlqSub(context)

        return this

    }

    /**
     * Get a specific context from list of set up contexts
     */
    getContext(name: string): SagaContext | undefined {

        return this.contexts[name]

    }

    private createTaskResponseSub<ResponseDataType extends DefaultSagaResponseType>(request_id: string) {

        const responseSub = new Promise<SagaResponseAsSuccess<ResponseDataType>>((resolve) => {

            this.response_channel_adapter!.subscribeToResponse<ResponseDataType>(request_id, (response) => {

                this.response_channel_adapter!.disposeSubscriptions(request_id)
                
                resolve({ response, kind: 'success' })

            })

        })

        return responseSub
        
    }

    private createTaskErrorSub<ErrorDataType extends DefaultSagaResponseType>(request_id: string) {

        const errorSub = new Promise<SagaResponseAsError<ErrorDataType>>((resolve) => {

            this.response_channel_adapter!.subscribeToError<ErrorDataType>(request_id, (error) => {

                this.response_channel_adapter!.disposeSubscriptions(request_id)

                resolve({ response: error, kind: 'error' })

            })

        })

        return errorSub

    }

    private createTimeoutSub(request_id: string, timeout: number) {

        const timeoutSub = new Promise<boolean>((resolve) => {
            
            setTimeout(() => {
                this.response_channel_adapter!.disposeSubscriptions(request_id)
                resolve(true)
            }, timeout)

        })

        return timeoutSub

    }

    private evaluateSagaResponse<
        ResponseDataType extends DefaultSagaResponseType,
        ErrorDataType extends DefaultSagaResponseType
    >(
        res: boolean | SagaResponseAsSuccess<ResponseDataType> | SagaResponseAsError<ErrorDataType>,
        context: SagaContext
    ) {

        if(res === true)
            throw new Error('Timeout of '+context.execTimeout+'ms reached while waiting for response from '+context.outputQueueName+' queue')

        const { response, kind } = res as Exclude<typeof res, boolean>

        switch(true) {
            
            case kind == 'error':
                const error = this.queue_adapter!.getErrorFromDeadLetter(response)
                throw error;
            case kind == 'success':
                return response;
            default:
                throw new Error('Unrecognized message received: '+JSON.stringify(response))

        }

    }

    /**
     * Executes a task within a given SagaContext and returns a response consumed from dedicated publication channel
     */
    async executeTask<
        RequestDataType extends DefaultSagaRequestType,
        ResponseDataType extends DefaultSagaResponseType,
        ErrorDataType extends DefaultSagaResponseType
    >(
        context: SagaContext,
        request: RequestDataType
    ) {

        if(!this.contexts[context.name]) this.setupContext(context)

        if(!context.inputQueueName) throw new Error('SagaContext should have input queue name specified')

        if(!this.contexts[context.name]) this.setupContext(context)
        
        this.queue_adapter!.sendSagaRequest(
            context.inputQueueName, request
        )

        const responseSub = this.createTaskResponseSub<ResponseDataType>(request.request_id),
            errorSub = this.createTaskErrorSub<ErrorDataType>(request.request_id)

        const res = context.execTimeout
            ? await Promise.race([ responseSub, errorSub, this.createTimeoutSub(request.request_id, context.execTimeout) ])
            : await Promise.race([ responseSub, errorSub ])

        return this.evaluateSagaResponse(res, context)        

    }

}