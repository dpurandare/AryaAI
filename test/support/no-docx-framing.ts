import { documentFraming } from '../../src/main/tools/office-docs/create'

// Many tests use office_create_document only to build a sample .docx; the head-and-tail rule is tested in create.test.ts.
documentFraming.enforce = false
