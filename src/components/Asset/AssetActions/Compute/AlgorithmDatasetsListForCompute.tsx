import React, { ReactElement, useEffect, useState } from 'react'
import styles from './AlgorithmDatasetsListForCompute.module.css'
import { getAlgorithmDatasetsForCompute } from '@utils/aquarius'
import { AssetSelectionAsset } from '@shared/FormInput/InputElement/AssetSelection'
import AssetComputeList from './AssetComputeList'
import { useCancelToken } from '@hooks/useCancelToken'
import { getServiceByName } from '@utils/ddo'
import { useWeb3 } from '@context/Web3'

export default function AlgorithmDatasetsListForCompute({
  asset,
  algorithmDid
}: {
  asset: AssetExtended
  algorithmDid: string
}): ReactElement {
  const { accountId } = useWeb3()
  const newCancelToken = useCancelToken()
  const [datasetsForCompute, setDatasetsForCompute] =
    useState<AssetSelectionAsset[]>()

  useEffect(() => {
    if (!asset || !asset?.accessDetails?.type) return

    async function getDatasetsAllowedForCompute() {
      const isCompute = Boolean(getServiceByName(asset, 'compute'))
      const datasetComputeService = getServiceByName(
        asset,
        isCompute ? 'compute' : 'access'
      )
      const datasets = await getAlgorithmDatasetsForCompute(
        algorithmDid,
        datasetComputeService?.serviceEndpoint,
        accountId,
        asset?.chainId,
        newCancelToken()
      )
      setDatasetsForCompute(datasets)
    }
    asset.metadata.type === 'algorithm' && getDatasetsAllowedForCompute()
  }, [accountId, asset, algorithmDid, newCancelToken])

  return (
    <div className={styles.datasetsContainer}>
      <h3 className={styles.text}>Datasets algorithm is allowed to run on</h3>
      <AssetComputeList assets={datasetsForCompute} />
    </div>
  )
}
