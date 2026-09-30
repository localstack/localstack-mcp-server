// The spawn smoke's Bicep fixture: no registry modules, so a build
// needs nothing but the local Bicep binary.
param location string = resourceGroup().location

resource st 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'stsmoke${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
}

output id string = st.id
