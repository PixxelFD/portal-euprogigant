import {
  Config,
  DDO,
  FreCreationParams,
  generateDid,
  DatatokenCreateParams,
  DispenserCreationParams,
  getHash,
  LoggerInstance,
  Metadata,
  NftCreateData,
  NftFactory,
  Service,
  ZERO_ADDRESS
} from '@oceanprotocol/lib'
import { mapTimeoutStringToSeconds, normalizeFile } from '@utils/ddo'
import { generateNftCreateData } from '@utils/nft'
import { getEncryptedFiles } from '@utils/provider'
import slugify from 'slugify'
import Web3 from 'web3'
import { algorithmContainerPresets } from './_constants'
import { FormPublishData, MetadataAlgorithmContainer } from './_types'
import {
  marketFeeAddress,
  publisherMarketOrderFee,
  publisherMarketFixedSwapFee,
  defaultDatatokenTemplateIndex,
  defaultAccessTerms,
  complianceApiVersion,
  complianceUri
} from '../../../app.config'
import { sanitizeUrl } from '@utils/url'
import { getContainerChecksum } from '@utils/docker'
import axios from 'axios'
import { ServiceCredential } from 'src/@types/gaia-x/2210/ServiceCredential'

function getUrlFileExtension(fileUrl: string): string {
  const splittedFileUrl = fileUrl.split('.')
  return splittedFileUrl[splittedFileUrl.length - 1]
}

async function getAlgorithmContainerPreset(
  dockerImage: string
): Promise<MetadataAlgorithmContainer> {
  if (dockerImage === '') return

  const preset = algorithmContainerPresets.find(
    (preset) => `${preset.image}:${preset.tag}` === dockerImage
  )
  preset.checksum = await (
    await getContainerChecksum(preset.image, preset.tag)
  ).checksum
  return preset
}

function dateToStringNoMS(date: Date): string {
  return date.toISOString().replace(/\.[0-9]{3}Z/, 'Z')
}

function transformTags(originalTags: string[]): string[] {
  const transformedTags = originalTags?.map((tag) => slugify(tag).toLowerCase())
  return transformedTags
}

export async function transformPublishFormToDdo(
  values: FormPublishData,
  // Those 2 are only passed during actual publishing process
  // so we can always assume if they are not passed, we are on preview.
  datatokenAddress?: string,
  nftAddress?: string
): Promise<DDO> {
  const { metadata, services, user } = values
  const { chainId, accountId } = user
  const {
    type,
    name,
    description,
    tags,
    author,
    termsAndConditions,
    dockerImage,
    dockerImageCustom,
    dockerImageCustomTag,
    dockerImageCustomEntrypoint,
    dockerImageCustomChecksum,
    gaiaXInformation
  } = metadata
  const { access, files, links, providerUrl, timeout } = services[0]

  const did = nftAddress ? generateDid(nftAddress, chainId) : '0x...'
  const currentTime = dateToStringNoMS(new Date())
  const isPreview = !datatokenAddress && !nftAddress

  const algorithmContainerPresets =
    type === 'algorithm' && dockerImage !== '' && dockerImage !== 'custom'
      ? await getAlgorithmContainerPreset(dockerImage)
      : null

  // Transform from files[0].url to string[] assuming only 1 file
  const filesTransformed = files?.length &&
    files[0].valid && [sanitizeUrl(files[0].url)]
  const linksTransformed = links?.length &&
    links[0].valid && [sanitizeUrl(links[0].url)]

  const accessTermsFileInfo = gaiaXInformation.termsAndConditions
  const accessTermsUrlTransformed = accessTermsFileInfo?.length &&
    accessTermsFileInfo[0].valid && [sanitizeUrl(accessTermsFileInfo[0].url)]

  const newMetadata: Metadata = {
    created: currentTime,
    updated: currentTime,
    type,
    name,
    description,
    tags: transformTags(tags),
    author,
    license:
      values.metadata.license || 'https://market.oceanprotocol.com/terms',
    links: linksTransformed,
    additionalInformation: {
      termsAndConditions,
      gaiaXInformation: {
        termsAndConditions: [
          { url: accessTermsUrlTransformed || defaultAccessTerms }
        ],
        ...(type === 'dataset' && {
          containsPII: gaiaXInformation.containsPII,
          PIIInformation: gaiaXInformation.PIIInformation
        }),
        serviceSD: gaiaXInformation?.serviceSD
      }
    },
    ...(type === 'algorithm' &&
      dockerImage !== '' && {
        algorithm: {
          language: filesTransformed?.length
            ? getUrlFileExtension(filesTransformed[0])
            : '',
          version: '0.1',
          container: {
            entrypoint:
              dockerImage === 'custom'
                ? dockerImageCustomEntrypoint
                : algorithmContainerPresets.entrypoint,
            image:
              dockerImage === 'custom'
                ? dockerImageCustom
                : algorithmContainerPresets.image,
            tag:
              dockerImage === 'custom'
                ? dockerImageCustomTag
                : algorithmContainerPresets.tag,
            checksum:
              dockerImage === 'custom'
                ? dockerImageCustomChecksum
                : algorithmContainerPresets.checksum
          }
        }
      })
  }

  const file = {
    nftAddress,
    datatokenAddress,
    files: [normalizeFile(files[0].type, files[0], chainId)]
  }

  const filesEncrypted =
    !isPreview &&
    files?.length &&
    files[0].valid &&
    (await getEncryptedFiles(file, chainId, providerUrl.url))

  const newService: Service = {
    id: getHash(datatokenAddress + filesEncrypted),
    type: access,
    files: filesEncrypted || '',
    datatokenAddress,
    serviceEndpoint: providerUrl.url,
    timeout: mapTimeoutStringToSeconds(timeout),
    ...(access === 'compute' && {
      compute: values.services[0].computeOptions
    })
  }

  const newDdo: DDO = {
    '@context': ['https://w3id.org/did/v1'],
    id: did,
    nftAddress,
    version: '4.1.0',
    chainId,
    metadata: newMetadata,
    services: [newService],
    // Only added for DDO preview, reflecting Asset response,
    // again, we can assume if `datatokenAddress` is not passed,
    // we are on preview.
    ...(!datatokenAddress && {
      datatokens: [
        {
          name: values.services[0].dataTokenOptions.name,
          symbol: values.services[0].dataTokenOptions.symbol
        }
      ],
      nft: {
        ...generateNftCreateData(values?.metadata.nft, accountId)
      }
    })
  }

  return newDdo
}

export async function createTokensAndPricing(
  values: FormPublishData,
  accountId: string,
  config: Config,
  nftFactory: NftFactory,
  web3: Web3
) {
  const nftCreateData: NftCreateData = generateNftCreateData(
    values.metadata.nft,
    accountId,
    values.metadata.transferable
  )
  LoggerInstance.log('[publish] Creating NFT with metadata', nftCreateData)

  // TODO: cap is hardcoded for now to 1000, this needs to be discussed at some point
  const ercParams: DatatokenCreateParams = {
    templateIndex: defaultDatatokenTemplateIndex,
    minter: accountId,
    paymentCollector: accountId,
    mpFeeAddress: marketFeeAddress,
    feeToken: values.pricing.baseToken.address,
    feeAmount: publisherMarketOrderFee,
    // max number
    cap: '115792089237316195423570985008687907853269984665640564039457',
    name: values.services[0].dataTokenOptions.name,
    symbol: values.services[0].dataTokenOptions.symbol
  }

  LoggerInstance.log('[publish] Creating datatoken with ercParams', ercParams)

  let erc721Address, datatokenAddress, txHash

  switch (values.pricing.type) {
    case 'fixed': {
      const freParams: FreCreationParams = {
        fixedRateAddress: config.fixedRateExchangeAddress,
        baseTokenAddress: values.pricing.baseToken.address,
        owner: accountId,
        marketFeeCollector: marketFeeAddress,
        baseTokenDecimals: values.pricing.baseToken.decimals,
        datatokenDecimals: 18,
        fixedRate: values.pricing.price.toString(),
        marketFee: publisherMarketFixedSwapFee,
        withMint: true
      }

      LoggerInstance.log(
        '[publish] Creating fixed pricing with freParams',
        freParams
      )

      const result = await nftFactory.createNftWithDatatokenWithFixedRate(
        accountId,
        nftCreateData,
        ercParams,
        freParams
      )

      erc721Address = result.events.NFTCreated.returnValues[0]
      datatokenAddress = result.events.TokenCreated.returnValues[0]
      txHash = result.transactionHash

      LoggerInstance.log('[publish] createNftErcWithFixedRate tx', txHash)

      break
    }
    case 'free': {
      // maxTokens -  how many tokens cand be dispensed when someone requests . If maxTokens=2 then someone can't request 3 in one tx
      // maxBalance - how many dt the user has in it's wallet before the dispenser will not dispense dt
      // both will be just 1 for the market
      const dispenserParams: DispenserCreationParams = {
        dispenserAddress: config.dispenserAddress,
        maxTokens: web3.utils.toWei('1'),
        maxBalance: web3.utils.toWei('1'),
        withMint: true,
        allowedSwapper: ZERO_ADDRESS
      }

      LoggerInstance.log(
        '[publish] Creating free pricing with dispenserParams',
        dispenserParams
      )

      const result = await nftFactory.createNftWithDatatokenWithDispenser(
        accountId,
        nftCreateData,
        ercParams,
        dispenserParams
      )
      erc721Address = result.events.NFTCreated.returnValues[0]
      datatokenAddress = result.events.TokenCreated.returnValues[0]
      txHash = result.transactionHash

      LoggerInstance.log('[publish] createNftErcWithDispenser tx', txHash)

      break
    }
  }

  return { erc721Address, datatokenAddress, txHash }
}

export function getComplianceApiVersion(context?: string[]): string {
  const latest = complianceApiVersion

  const allowedRegistryDomains = [
    'https://registry.gaia-x.eu/v2206',
    'https://registry.lab.gaia-x.eu/v2206'
  ]
  if (
    !context ||
    !context.length ||
    context.some(
      (e) => allowedRegistryDomains.findIndex((x) => e.startsWith(x)) !== -1
    )
  )
    return latest

  return '2204'
}

export async function signServiceCredential(
  rawServiceCredential: any
): Promise<any> {
  if (!rawServiceCredential) return
  try {
    const response = await axios.post(
      `${complianceUri}/api/sign`,
      rawServiceCredential
    )
    const signedServiceCredential = {
      selfDescriptionCredential: { ...rawServiceCredential },
      ...response.data
    }

    return signedServiceCredential
  } catch (error) {
    LoggerInstance.error(error.message)
  }
}

export async function storeRawServiceSD(signedSD: {
  complianceCredentials: any
  selfDescriptionCredential: any
}): Promise<{
  verified: boolean
  storedSdUrl: string | undefined
}> {
  if (!signedSD) return { verified: false, storedSdUrl: undefined }

  const baseUrl = `${complianceUri}/api/service-offering/verify/raw?store=true`
  try {
    const response = await axios.post(baseUrl, signedSD)
    if (response?.status === 409) {
      return {
        verified: false,
        storedSdUrl: undefined
      }
    }
    if (response?.status === 200) {
      return { verified: true, storedSdUrl: response.data.storedSdUrl }
    }

    return { verified: false, storedSdUrl: undefined }
  } catch (error) {
    LoggerInstance.error(error.message)
    return { verified: false, storedSdUrl: undefined }
  }
}

export async function verifyRawServiceCredential(
  rawServiceCredential: string,
  did?: string
): Promise<{
  verified: boolean
  complianceApiVersion?: string
  idMatch?: boolean
  responseBody?: any
}> {
  if (!rawServiceCredential) return { verified: false }

  const parsedServiceCredential = JSON.parse(rawServiceCredential)
  // TODO: put back the compliance API version check
  // const complianceApiVersion = getComplianceApiVersion(
  //   parsedServiceSD?.selfDescriptionCredential?.['@context']
  // )

  const baseUrl = `${complianceUri}/main/api/credential-offers`

  try {
    const response = await axios.post(baseUrl, parsedServiceCredential)
    if (response?.status === 409) {
      return {
        verified: false,
        responseBody: response.data.body
      }
    }
    if (response?.status === 201) {
      const serviceOffering = parsedServiceCredential.verifiableCredential.find(
        (credential) =>
          credential?.credentialSubject?.type === 'gx:ServiceOffering'
      )
      const credentialId = serviceOffering?.credentialSubject?.id

      return {
        verified: true,
        complianceApiVersion,
        idMatch: did && did?.toLowerCase() === credentialId?.toLowerCase()
      }
    }

    return { verified: false }
  } catch (error) {
    LoggerInstance.error(error.message)
    return { verified: false }
  }
}

export async function getServiceCredential(url: string): Promise<string> {
  if (!url) return

  try {
    const serviceCredential = await axios.get(url)
    return JSON.stringify(serviceCredential.data, null, 2)
  } catch (error) {
    LoggerInstance.error(error.message)
  }
}

export function getFormattedCodeString(parsedCodeBlock: any): string {
  const formattedString = JSON.stringify(parsedCodeBlock, null, 2)
  return `\`\`\`\n${formattedString}\n\`\`\``
}

export function updateServiceCredential(
  ddo: DDO,
  serviceCredential: ServiceCredential
): DDO {
  const { raw, url } = serviceCredential
  ddo.metadata.additionalInformation.gaiaXInformation.serviceSelfDescription = {
    raw,
    url
  }

  return ddo
}

export function getPublisherFromServiceCredential(
  serviceCredential: any
): string {
  if (!serviceCredential) return
  const parsedServiceCredential =
    typeof serviceCredential === 'string'
      ? JSON.parse(serviceCredential)
      : serviceCredential

  const legalName =
    parsedServiceCredential?.verifiableCredential?.[0]?.credentialSubject?.[
      'gx:legalName'
    ]
  const publisher =
    typeof legalName === 'string' ? legalName : legalName?.['@value']

  return publisher
}
